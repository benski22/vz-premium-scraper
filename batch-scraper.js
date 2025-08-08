console.log('BATCH ENV:', {
  articlesCount: JSON.parse(process.env.ARTICLES || '[]').length,
  trendingTopics: process.env.TRENDING_TOPICS ? 'Present' : 'Missing',
  webhook: process.env.WEBHOOK_URL
});

const puppeteer = require('puppeteer');
const axios = require('axios');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Detect domain type from URL
function getDomainType(url) {
  if (url.includes('manopinigai.vz.lt')) {
    return 'manopinigai';
  }
  return 'vz';
}

// Universal VZ login function
async function performLogin(page, email, password, domainType) {
  if (domainType === 'manopinigai') {
    console.log('Logging into Mano Pinigai...');
    await page.goto('https://prisijungimas.vz.lt/mano-pinigai', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } else {
    console.log('Logging into VZ...');
    await page.goto('https://prisijungimas.vz.lt/verslo-zinios', { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  
  await delay(3000);

  // Email input
  const emailSelectors = ['#email', 'input[id="email"]', 'input[type="text"][placeholder*="pašto"]', 'input[autocomplete="vzusername"]', 'input[type="text"]', 'input[name="email"]'];
  let emailFound = false;

  for (const selector of emailSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.type(selector, email, { delay: 100 });
      emailFound = true;
      break;
    } catch {}
  }

  if (!emailFound) throw new Error('Email input not found');

  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });

  // Password input
  const passwordSelectors = ['input[type="password"]', '#password', 'input[name="password"]'];
  let passwordEntered = false;
  
  for (const selector of passwordSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.type(selector, password, { delay: 100 });
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
      passwordEntered = true;
      break;
    } catch {}
  }

  if (!passwordEntered) throw new Error('Password input not found');
  
  console.log(`✅ Successfully logged into ${domainType === 'manopinigai' ? 'Mano Pinigai' : 'VZ'}`);
}

async function scrapeVZArticle(url, email, password) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Detect domain type
    const domainType = getDomainType(url);
    console.log(`Domain detected: ${domainType} for URL: ${url}`);

    // Perform appropriate login
    await performLogin(page, email, password, domainType);

    // Navigate to article
    console.log(`Accessing article: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Wait for content to load and check login status
    if (domainType === 'manopinigai') {
      console.log('Checking ManoPinigai login status...');
      
      // Check if we're still on login page or if paywall is blocking
      const isLoginPage = await page.evaluate(() => {
        return window.location.href.includes('prisijungimas') || 
               document.querySelector('input[type="password"]') !== null;
      });
      
      const hasPaywallBlock = await page.evaluate(() => {
        const paywallText = document.body.textContent;
        return paywallText.includes('Prenumeruoti') && paywallText.includes('Prisijungti') &&
               !paywallText.includes('Paulius Kabelis'); // Check for actual content
      });
      
      console.log('Login status check:', { isLoginPage, hasPaywallBlock });
      
      if (isLoginPage) {
        throw new Error('Still on login page - authentication might have failed');
      }
      
      if (hasPaywallBlock) {
        console.log('Detected paywall, trying to wait for content...');
        await delay(5000); // Additional wait
      }
    }

    // Domain-specific content extraction
    const articleText = await page.evaluate((domainType) => {
      let content = '';
      
      // Remove unwanted elements first
      const unwantedSelectors = [
        '.infogram-embed', '.sas', '.has-ad-desktop', '.rekvizitai-embed',
        'iframe[src*="infogram"]', 'iframe[src*="rekvizitai"]',
        'figure.infogram-embed', 'figure.rekvizitai-embed',
        '.author-disclaimer', '.suggestion-form', 'form',
        '.article-social-links', '.article-comments',
        'script', 'style', 'nav', 'header', 'footer',
        '.advertisement', '.banner', 'figcaption',
        '.w-full.bg-vzGrey-2', '.additional-info', // ManoPinigai ad blocks
        '[id^="sas_"]' // SAS ad elements
      ];
      
      unwantedSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove());
      });

      if (domainType === 'manopinigai') {
        console.log('Using ManoPinigai extraction logic');
        
        // Debug: Check what elements exist
        const ckContentExists = document.querySelector('.ck-content.paywall') !== null;
        const ckContentRegularExists = document.querySelector('.ck-content') !== null;
        const articleContentExists = document.querySelector('.article-content') !== null;
        
        console.log('Debug - Element existence:', {
          'ck-content paywall': ckContentExists,
          'ck-content': ckContentRegularExists, 
          'article-content': articleContentExists
        });
        
        // Try multiple ManoPinigai selectors
        let ckContent = document.querySelector('.ck-content.paywall') || 
                        document.querySelector('.ck-content') ||
                        document.querySelector('.article-content .ck-content') ||
                        document.querySelector('.article-content');
        
        if (ckContent) {
          console.log('Found content container:', ckContent.className);
          
          // Get all text elements
          const contentElements = ckContent.querySelectorAll('p, h2, h3, h4, strong');
          console.log(`Found ${contentElements.length} content elements`);
          
          contentElements.forEach((element, index) => {
            let text = element.textContent?.trim();
            
            if (!text || text.length < 3) {
              console.log(`Skipping empty element ${index}`);
              return;
            }
            
            // Debug first few elements
            if (index < 5) {
              console.log(`Element ${index} (${element.tagName}): ${text.substring(0, 100)}...`);
            }
            
            // Skip unwanted content
            if (text.includes('Prenumeruoti') || 
                text.includes('Prisijungti') || 
                text.includes('DAUGIAU SKAITYKITE') ||
                text.includes('Norite pasiūlyti temą') ||
                text.includes('redaktoriams') ||
                text.includes('nuotr.') ||
                text.includes('koliažas')) {
              console.log(`Skipping unwanted content: ${text.substring(0, 50)}...`);
              return;
            }
            
            // Add headers with spacing
            if (element.tagName === 'H2' || element.tagName === 'H3' || element.tagName === 'H4') {
              content += '\n' + text + '\n\n';
            } else if (element.tagName === 'STRONG' && element.parentNode.tagName === 'P' && 
                      text.length > 50) {
              // Handle bold introductions
              content += text + '\n\n';
            } else if (element.tagName === 'P') {
              // Regular paragraph
              content += text + '\n\n';
            }
          });
          
          console.log(`ManoPinigai content extracted: ${content.length} characters`);
        } else {
          console.log('No ManoPinigai content container found');
        }
        
      } else {
        console.log('Using VZ extraction logic');
        
        // Original VZ extraction logic
        const summaryElement = document.querySelector('summary');
        if (summaryElement) {
          content += summaryElement.textContent.trim() + '\n\n';
        }
        
        const contentParagraphs = document.querySelectorAll('.content-paragraph');
        
        contentParagraphs.forEach(paragraph => {
          if (paragraph.querySelector('i')) return; // Skip disclaimers
          
          // Check if it's a header
          const strongElement = paragraph.querySelector('strong');
          if (strongElement && 
              paragraph.textContent.trim() === strongElement.textContent.trim() &&
              strongElement.textContent.trim().length > 5) {
            content += strongElement.textContent.trim() + '\n\n';
            return;
          }
          
          // Regular paragraph
          let paragraphText = '';
          
          Array.from(paragraph.childNodes).forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
              paragraphText += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.tagName === 'A') {
                paragraphText += node.textContent;
              } else if (node.tagName !== 'I') {
                paragraphText += node.textContent;
              }
            }
          });
          
          const cleanText = paragraphText.trim();
          if (cleanText && cleanText.length > 10) {
            content += cleanText + '\n\n';
          }
        });
      }
      
      // Universal fallback for both domains
      if (!content || content.trim().length < 100) {
        console.log('Using fallback extraction');
        const fallbackSelectors = [
          '.article-content', '.article-body', '.content-body', 
          'article .content', 'main article', '.post-content', '.entry-content'
        ];
        
        for (const selector of fallbackSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            const text = element.innerText || element.textContent || '';
            if (text.trim().length > 200) {
              content = text.trim();
              break;
            }
          }
        }
      }
      
      console.log(`Content extracted length: ${content.length}`);
      return content.trim();
    }, domainType);

    // Final fallback
    let finalArticleText = articleText;
    if (!finalArticleText || finalArticleText.length < 100) {
      console.log('Primary extraction failed, trying fallback...');
      
      finalArticleText = await page.evaluate(() => {
        // More aggressive fallback for ManoPinigai
        const bodyText = document.body.innerText || document.body.textContent || '';
        
        // Try to extract meaningful paragraphs
        const paragraphs = bodyText.split('\n').filter(line => {
          const trimmed = line.trim();
          return trimmed.length > 50 && 
                 !trimmed.includes('Prenumeruoti') &&
                 !trimmed.includes('Prisijungti') &&
                 !trimmed.includes('nuotr.') &&
                 !trimmed.includes('koliažas') &&
                 !trimmed.includes('© VŽ');
        });
        
        console.log(`Fallback found ${paragraphs.length} potential paragraphs`);
        return paragraphs.slice(0, 20).join('\n\n'); // Take first 20 paragraphs
      });
    }

    if (!finalArticleText || finalArticleText.length < 50) {
      // Final debug info
      const debugInfo = await page.evaluate(() => {
        return {
          url: window.location.href,
          title: document.title,
          hasPaywall: document.querySelector('.paywall') !== null,
          hasLogin: document.querySelector('input[type="password"]') !== null,
          bodyLength: document.body.innerText?.length || 0,
          contentPreview: document.body.innerText?.substring(0, 500) || 'No content'
        };
      });
      
      console.log('Final debug info:', debugInfo);
      throw new Error(`Article content too short (${finalArticleText?.length || 0} chars) or not found - might be behind paywall or login failed`);
    }

    console.log('Content preview:', finalArticleText.substring(0, 200) + '...');
    console.log(`Content length: ${finalArticleText.length} characters`);
    
    return finalArticleText.substring(0, 8000);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

// BATCH PROCESSING FUNKCIJA
async function scrapeBatch() {
  const articles = JSON.parse(process.env.ARTICLES || '[]');
  const trendingTopics = process.env.TRENDING_TOPICS || '';
  const webhookUrl = process.env.WEBHOOK_URL;

  console.log(`🎯 Starting batch scraping for ${articles.length} articles`);
  
  // Log domain distribution
  const vzCount = articles.filter(a => !a.url.includes('manopinigai')).length;
  const manoPinigaiCount = articles.filter(a => a.url.includes('manopinigai')).length;
  console.log(`Domain distribution: ${vzCount} VZ articles, ${manoPinigaiCount} ManoPinigai articles`);
  
  const results = [];
  
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    
    try {
      const domainType = getDomainType(article.url);
      console.log(`[${i + 1}/${articles.length}] Scraping (${domainType}): ${article.title?.substring(0, 50)}...`);
      
      const scrapedText = await scrapeVZArticle(
        article.url,
        process.env.VZ_EMAIL,
        process.env.VZ_PASSWORD
      );
      
      results.push({
        url: article.url,
        title: article.title,
        pubDate: article.pubDate,
        text: scrapedText,
        trending_topics: trendingTopics
      });
      
      console.log(`✅ [${i + 1}/${articles.length}] Successfully scraped ${domainType} article`);
      
      // Delay between articles
      if (i < articles.length - 1) {
        console.log('⏳ Waiting 3 seconds before next article...');
        await delay(3000);
      }
      
    } catch (error) {
      console.error(`❌ [${i + 1}/${articles.length}] Error scraping ${article.url}:`, error.message);
      // Continue with other articles
    }
  }
  
  console.log(`📊 Batch complete: ${results.length}/${articles.length} articles scraped successfully`);
  
  // Send batch to webhook
  if (results.length > 0) {
    try {
      await axios.post(webhookUrl, { articles: results });
      console.log(`🚀 Successfully sent batch of ${results.length} articles to webhook`);
    } catch (error) {
      console.error('❌ Failed to send batch to webhook:', error.message);
      throw error;
    }
  } else {
    console.log('⚠️ No articles scraped successfully - nothing to send');
  }
}

// MAIN EXECUTION
(async () => {
  try {
    await scrapeBatch();
    console.log('🎉 Batch scraping completed successfully');
  } catch (e) {
    console.error('💥 Batch scraping failed:', e.message);
    process.exit(1);
  }
})();
