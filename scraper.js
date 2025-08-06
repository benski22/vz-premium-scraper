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

    const contentSelectors = ['.article-content', '.article-body', '.content-body', 'article .content', '[class*="article-content"]', '.story-content', 'main article'];
    let articleText = '';

    for (const selector of contentSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const text = await page.evaluate(el => el.innerText, element);
          if (text && text.trim().length > 200) {
            articleText = text.trim();
            break;
          }
        }
      } catch {}
    }

    if (!articleText || articleText.length < 100) {
      articleText = await page.evaluate(() => {
        document.querySelectorAll('script, style, nav, header, footer, .advertisement, .banner').forEach(el => el.remove());
        const main = document.querySelector('main') || document.querySelector('.main') || document.body;
        return main.innerText || '';
      });
    }

    if (!articleText || articleText.length < 50) {
      throw new Error('Article content too short');
    }

    await axios.post(process.env.WEBHOOK_URL, {
      url: process.env.URL,
      title: process.env.ARTICLE_TITLE,
      pubDate: process.env.ARTICLE_PUBDATE,
      text: articleText.substring(0, 8000),
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
