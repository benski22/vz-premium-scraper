const puppeteer = require('puppeteer');

async function scrapeVZArticle(url, email, password) {
  const browser = await puppeteer.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    
    // Login process
    await page.goto('https://prisijungimas.vz.lt/verslo-zinios');
    await page.type('input[type="email"]', email);
    await page.click('button[type="submit"]');
    await page.waitForNavigation();
    
    await page.type('input[type="password"]', password);
    await page.click('button[type="submit"]');  
    await page.waitForNavigation();
    
    // Scrape article
    await page.goto(url);
    await page.waitForSelector('.article-content', { timeout: 10000 });
    
    const articleText = await page.evaluate(() => {
      const content = document.querySelector('.article-content');
      return content ? content.innerText : '';
    });
    
    return articleText;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeVZArticle };
