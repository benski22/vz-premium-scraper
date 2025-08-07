console.log('ENV:', {
  url: process.env.URL,
  title: process.env.TITLE,
  pubDate: process.env.PUBDATE,
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
  
      // 3. Ieškoti article container'io
      const articleContainer = document.querySelector('.article-content') || 
                              document.querySelector('main article') || 
                              document.querySelector('.content-body');
  
      if (articleContainer) {
      // Eiti per visus child elementus ir išlaikyti struktūrą
      Array.from(articleContainer.children).forEach(element => {
      
        // Antraštės (h2, h3, h4, arba strong pastraipose)
        if (element.tagName && ['H2', 'H3', 'H4'].includes(element.tagName)) {
          const headerText = element.textContent.trim();
          if (headerText) {
            content += headerText + '\n\n';
          }
        }
        // Pastraipų su antraštėmis tikrinimas  
        else if (element.classList.contains('content-paragraph')) {
          // Praleisti italic disclaimers
          if (element.querySelector('i')) return;
        
          // Tikrinti, ar tai antraštė (strong/bold tekstas)
          const strongElement = element.querySelector('strong');
          if (strongElement && strongElement.textContent.trim().length > 0 && 
              element.textContent.trim() === strongElement.textContent.trim()) {
            // Tai antraštė
            content += strongElement.textContent.trim() + '\n\n';
            return;
          }
        
          // Įprastas paragrafas
          let paragraphText = '';
          Array.from(element.childNodes).forEach(node => {
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
        }
      });
    }
  
    // 4. Fallback jei nepavyko
    if (!content || content.trim().length < 100) {
      // (palikti esamą fallback kodą)
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
        // Pašalinti visus nereikalingus elementus
        document.querySelectorAll('script, style, nav, header, footer, .advertisement, .banner, .sas, .infogram-embed, .rekvizitai-embed').forEach(el => el.remove());
        const main = document.querySelector('main') || document.querySelector('.main') || document.body;
        return main.innerText || '';
      });
    }

    if (!finalArticleText || finalArticleText.length < 50) {
      throw new Error('Article content too short or not found');
    }

    console.log('Content preview:', finalArticleText.substring(0, 200) + '...');

    await axios.post(process.env.WEBHOOK_URL, {
      url: process.env.URL,
      title: process.env.TITLE,
      pubDate: process.env.PUBDATE,
      text: finalArticleText.substring(0, 8000),
      trending_topics: process.env.TRENDING_TOPICS || ''
    });

    console.log('✅ Content sent to webhook.');
    return 'Done';
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

(async () => {
  try {
    await scrapeVZArticle(
      process.env.URL,
      process.env.VZ_EMAIL,
      process.env.VZ_PASSWORD
    );
  } catch (e) {
    process.exit(1);
  }
})();

