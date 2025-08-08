console.log('OPTIMIZED BATCH ENV:', {
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

// Group articles by domain type
function groupArticlesByDomain(articles) {
  const vzArticles = articles.filter(article => getDomainType(article.url) === 'vz');
  const manoPinigaiArticles = articles.filter(article => getDomainType(article.url) === 'manopinigai');
  
  return { vzArticles, manoPinigaiArticles };
}

// Universal VZ login function (optimized)
async function performLogin(page, email, password, domainType) {
  console.log(`🔐 Logging into ${domainType === 'manopinigai' ? 'Mano Pinigai' : 'VZ'}...`);
  
  if (domainType === 'manopinigai') {
    await page.goto('https://prisijungimas.vz.lt/mano-pinigai', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } else {
    await page.goto('https://prisijungimas.vz.lt/verslo-zinios', { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  
  await delay(2000); // Reduced from 3000

  // Email input
  const emailSelectors = ['#email', 'input[id="email"]', 'input[type="text"][placeholder*="pašto"]', 'input[autocomplete="vzusername"]', 'input[type="text"]', 'input[name="email"]'];
  let emailFound = false;

  for (const selector of emailSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.type(selector, email, { delay: 50 }); // Reduced typing delay
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
      await page.type(selector, password, { delay: 50 }); // Reduced typing delay
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
      passwordEntered = true;
      break;
    } catch {}
  }

  if (!passwordEntered) throw new Error('Password input not found');
  
  console.log(`✅ Successfully logged into ${domainType === 'manopinigai' ? 'Mano Pinigai' : 'VZ'}`);
}

// Extract content from article page
async function extractArticleContent(page, url, domainType) {
  console.log(`📖 Extracting content from: ${url}`);
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Wait for content to load
    if (domainType === 'manopinigai') {
      console.log('⏳ Checking ManoPinigai login status...');
      
      // Check if we're still on login page or if paywall is blocking
      const isLoginPage = await page.evaluate(() => {
        return window.location.href.includes('prisijungimas') || 
               document.querySelector('input[type="password"]') !== null;
      });
      
      if (isLoginPage) {
        throw new Error('Still on login page - session might have expired');
      }
      
      await delay(2000); // Reduced wait time
    } else {
      await delay(1000); // Minimal wait for VZ
    }

    // Extract content using existing logic
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
        '.w-full.bg-vzGrey-2', '.additional-info',
        '[id^="sas_"]'
      ];
      
      unwantedSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove());
      });

      if (domainType === 'manopinigai') {
        // ManoPinigai extraction logic
        let ckContent = document.querySelector('.ck-content.paywall') || 
                        document.querySelector('.ck-content') ||
                        document.querySelector('.article-content .ck-content') ||
                        document.querySelector('.article-content');
        
        if (ckContent) {
          const contentElements = ckContent.querySelectorAll('p, h2, h3, h4, strong');
          let foundEndMarker = false;
          
          contentElements.forEach((element, index) => {
            let text = element.textContent?.trim();
            
            if (!text || text.length < 3) return;
            
            // Stop processing after "DAUGIAU SKAITYKITE" section
            if (text.includes('DAUGIAU SKAITYKITE') || 
                text.includes('SUSIJĘ STRAIPSNIAI') ||
                text.includes('TAIP PAT SKAITYKITE')) {
              foundEndMarker = true;
              return;
            }
            
            if (foundEndMarker) return;
            
            // Skip unwanted content
            if (text.includes('Prenumeruoti') || 
                text.includes('Prisijungti') || 
                text.includes('DAUGIAU SKAITYKITE') ||
                text.includes('Norite pasiūlyti temą') ||
                text.includes('redaktoriams') ||
                text.includes('nuotr.') ||
                text.includes('koliažas') ||
                element.tagName === 'A' ||
                element.parentNode?.tagName === 'A' ||
                text.includes('Ar verta antros pakopos') ||
                text.includes('II pensijų pakopos pinigai') ||
                text.includes('pensijų pakopos pinigus') ||
                (text.length < 100 && (
                  text.includes('pinigus perkelti') ||
                  text.includes('santaupas įdarbinti') ||
                  text.includes('kodėl svarbu') ||
                  text.includes('specialistai pataria')
                ))) {
              return;
            }
            
            // Add headers with spacing
            if (element.tagName === 'H2' || element.tagName === 'H3' || element.tagName === 'H4') {
              content += '\n' + text + '\n\n';
            } else if (element.tagName === 'STRONG' && element.parentNode.tagName === 'P' && 
                      text.length > 50) {
              content += text + '\n\n';
            } else if (element.tagName === 'P') {
              content += text + '\n\n';
            }
          });
        }
        
      } else {
        // VZ extraction logic
        const summaryElement = document.querySelector('summary');
        if (summaryElement) {
          content += summaryElement.textContent.trim() + '\n\n';
        }
        
        const contentParagraphs = document.querySelectorAll('.content-paragraph');
        
        contentParagraphs.forEach(paragraph => {
          if (paragraph.querySelector('i')) return;
          
          const strongElement = paragraph.querySelector('strong');
          if (strongElement && 
              paragraph.textContent.trim() === strongElement.textContent.trim() &&
              strongElement.textContent.trim().length > 5) {
            content += strongElement.textContent.trim() + '\n\n';
            return;
          }
          
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
      
      // Universal fallback
      if (!content || content.trim().length < 100) {
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
      
      return content.trim();
    }, domainType);

    // Final fallback if content is too short
    let finalArticleText = articleText;
    if (!finalArticleText || finalArticleText.length < 100) {
      finalArticleText = await page.evaluate(() => {
        const bodyText = document.body.innerText || document.body.textContent || '';
        
        const paragraphs = bodyText.split('\n').filter(line => {
          const trimmed = line.trim();
          return trimmed.length > 50 && 
                 !trimmed.includes('Prenumeruoti') &&
                 !trimmed.includes('Prisijungti') &&
                 !trimmed.includes('nuotr.') &&
                 !trimmed.includes('koliažas') &&
                 !trimmed.includes('© VŽ');
        });
        
        return paragraphs.slice(0, 20).join('\n\n');
      });
    }

    if (!finalArticleText || finalArticleText.length < 50) {
      throw new Error(`Article content too short (${finalArticleText?.length || 0} chars) - might be behind paywall`);
    }

    console.log(`📝 Content preview: ${finalArticleText.substring(0, 150)}...`);
    console.log(`📊 Content length: ${finalArticleText.length} characters`);
    
    // 20,000 character limit
    const maxLength = 20000;
    const trimmedText = finalArticleText.substring(0, maxLength);
    
    if (finalArticleText.length > maxLength) {
      console.log(`⚠️  Content truncated from ${finalArticleText.length} to ${maxLength} characters`);
    }
    
    return trimmedText;
    
  } catch (error) {
    console.error(`❌ Error extracting content from ${url}:`, error.message);
    throw error;
  }
}

// Scrape articles by domain (session reuse)
async function scrapeArticlesByDomain(articles, domainType, email, password, trendingTopics) {
  if (articles.length === 0) {
    console.log(`📋 No ${domainType} articles to process`);
    return [];
  }

  console.log(`🚀 Starting ${domainType} batch: ${articles.length} articles`);
  
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const results = [];

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Single login per domain
    await performLogin(page, email, password, domainType);
    
    // Process all articles in this domain
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      
      try {
        console.log(`[${i + 1}/${articles.length}] ${domainType.toUpperCase()}: ${article.title?.substring(0, 50)}...`);
        
        const scrapedText = await extractArticleContent(page, article.url, domainType);
        
        results.push({
          url: article.url,
          title: article.title,
          pubDate: article.pubDate,
          text: scrapedText,
          trending_topics: trendingTopics
        });
        
        console.log(`✅ [${i + 1}/${articles.length}] Successfully scraped ${domainType} article`);
        
        // Reduced delay between articles (same session)
        if (i < articles.length - 1) {
          console.log('⏳ Waiting 1 second before next article...');
          await delay(1000); // Reduced from 3000ms
        }
        
      } catch (error) {
        console.error(`❌ [${i + 1}/${articles.length}] Error scraping ${article.url}:`, error.message);
        
        // If session expired, try to re-login once
        if (error.message.includes('session') || error.message.includes('login')) {
          console.log('🔄 Attempting to re-login...');
          try {
            await performLogin(page, email, password, domainType);
            console.log('✅ Re-login successful, continuing...');
          } catch (reLoginError) {
            console.error('❌ Re-login failed:', reLoginError.message);
            break; // Exit this domain batch
          }
        }
      }
    }
    
  } catch (error) {
    console.error(`💥 Critical error in ${domainType} batch:`, error.message);
  } finally {
    await browser.close();
  }
  
  console.log(`📊 ${domainType.toUpperCase()} batch complete: ${results.length}/${articles.length} articles scraped`);
  return results;
}

// OPTIMIZED BATCH PROCESSING
async function scrapeBatchOptimized() {
  const articles = JSON.parse(process.env.ARTICLES || '[]');
  const trendingTopics = process.env.TRENDING_TOPICS || '';
  const webhookUrl = process.env.WEBHOOK_URL;

  console.log(`🎯 Starting OPTIMIZED batch scraping for ${articles.length} articles`);
  
  // Group articles by domain
  const { vzArticles, manoPinigaiArticles } = groupArticlesByDomain(articles);
  console.log(`📊 Domain distribution: ${vzArticles.length} VZ articles, ${manoPinigaiArticles.length} ManoPinigai articles`);
  
  const allResults = [];
  
  // Process VZ articles (if any)
  if (vzArticles.length > 0) {
    const vzResults = await scrapeArticlesByDomain(
      vzArticles, 
      'vz', 
      process.env.VZ_EMAIL, 
      process.env.VZ_PASSWORD, 
      trendingTopics
    );
    allResults.push(...vzResults);
  }
  
  // Process ManoPinigai articles (if any)
  if (manoPinigaiArticles.length > 0) {
    const manoPinigaiResults = await scrapeArticlesByDomain(
      manoPinigaiArticles, 
      'manopinigai', 
      process.env.VZ_EMAIL, 
      process.env.VZ_PASSWORD, 
      trendingTopics
    );
    allResults.push(...manoPinigaiResults);
  }
  
  console.log(`🎉 OPTIMIZED batch complete: ${allResults.length}/${articles.length} articles scraped successfully`);
  
  // Send batch to webhook
  if (allResults.length > 0) {
    try {
      await axios.post(webhookUrl, { articles: allResults });
      console.log(`🚀 Successfully sent batch of ${allResults.length} articles to webhook`);
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
    await scrapeBatchOptimized();
    console.log('🎉 OPTIMIZED batch scraping completed successfully');
  } catch (e) {
    console.error('💥 OPTIMIZED batch scraping failed:', e.message);
    process.exit(1);
  }
})();
