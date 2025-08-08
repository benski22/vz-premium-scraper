console.log('BATCH ENV:', {
  articlesCount: JSON.parse(process.env.ARTICLES || '[]').length,
  trendingTopics: process.env.TRENDING_TOPICS ? 'Present' : 'Missing',
  webhook: process.env.WEBHOOK_URL
});

const puppeteer = require('puppeteer');
const axios = require('axios');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

    console.log('Accessing VZ login page...');
    await page.goto('https://prisijungimas.vz.lt/verslo-zinios', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(3000);

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

    const passwordSelectors = ['input[type="password"]', '#password', 'input[name="password"]'];
    for (const selector of passwordSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.type(selector, password, { delay: 100 });
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      } catch {}
    }

    console.log(`Accessing article: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(5000);

    // VŽ specifinis content extraction
    const articleText = await page.evaluate(() => {
      let content = '';
      
      // 1. Ištraukti summary
      const summaryElement = document.querySelector('summary');
      if (summaryElement) {
        content += summaryElement.textContent.trim() + '\n\n';
      }
      
      // 2. Pašalinti nereikalingus elementus prieš analizę
      const unwantedSelectors = [
        '.infogram-embed',
        '.sas',
        '.has-ad-desktop',
        '.rekvizitai-embed',
        'iframe[src*="infogram"]',
        'iframe[src*="rekvizitai"]',
        'figure.infogram-embed',
        'figure.rekvizitai-embed',
        '.author-disclaimer'
      ];
      
      unwantedSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove());
      });
      
      // 3. Ištraukti content-paragraph tekstus
      const contentParagraphs = document.querySelectorAll('.content-paragraph');
      
      contentParagraphs.forEach(paragraph => {
        // Praleisti, jei yra italic disclaimer
        if (paragraph.querySelector('i')) return;
        
        // Tikrinti ar tai antraštė
        const strongElement = paragraph.querySelector('strong');
        if (strongElement && 
            paragraph.textContent.trim() === strongElement.textContent.trim() &&
            strongElement.textContent.trim().length > 5) {
          // Tai antraštė
          content += strongElement.textContent.trim() + '\n\n';
          return;
        }
        
        // Įprastas paragrafas
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
      
      // 4. Fallback
      if (!content || content.trim().length < 100) {
        const fallbackSelectors = ['.article-content', '.article-body', '.content-body', 'article .content', 'main article'];
        
        for (const selector of fallbackSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            element.querySelectorAll('script, style, nav, header, footer, .advertisement, .banner, .sas, .infogram-embed, .rekvizitai-embed').forEach(el => el.remove());
            const text = element.innerText || element.textContent || '';
            if (text.trim().length > 200) {
              content = text.trim();
              break;
            }
          }
        }
      }
      
      return content.trim();
    });

    // Fallback jei vis dar nėra turinio
    let finalArticleText = articleText;
    if (!finalArticleText || finalArticleText.length < 100) {
      finalArticleText = await page.evaluate(() => {
        document.querySelectorAll('script, style, nav, header, footer, .advertisement, .banner, .sas, .infogram-embed, .rekvizitai-embed').forEach(el => el.remove());
        const main = document.querySelector('main') || document.querySelector('.main') || document.body;
        return main.innerText || '';
      });
    }

    if (!finalArticleText || finalArticleText.length < 50) {
      throw new Error('Article content too short or not found');
    }

    console.log('Content preview:', finalArticleText.substring(0, 200) + '...');
    
    // GRĄŽINTI TEKSTĄ (ne siųsti webhook)
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
  
  const results = [];
  
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    
    try {
      console.log(`[${i + 1}/${articles.length}] Scraping: ${article.title?.substring(0, 50)}...`);
      
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
      
      console.log(`✅ [${i + 1}/${articles.length}] Successfully scraped`);
      
      // Delay tarp straipsnių (išvengti rate limiting)
      if (i < articles.length - 1) {
        console.log('⏳ Waiting 3 seconds before next article...');
        await delay(3000);
      }
      
    } catch (error) {
      console.error(`❌ [${i + 1}/${articles.length}] Error scraping ${article.url}:`, error.message);
      // Tęsti su kitais straipsniais
    }
  }
  
  console.log(`📊 Batch complete: ${results.length}/${articles.length} articles scraped successfully`);
  
  // Siųsti visą batch'ą vienu webhook call'u
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
