const puppeteer = require('puppeteer');

async function scrapeVZArticle(url, email, password) {
  const browser = await puppeteer.launch({ 
    headless: "new", // Pataisyta Puppeteer warning
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    
    // Login process - bandyti kelis selector'ius
    await page.goto('https://prisijungimas.vz.lt/verslo-zinios', { waitUntil: 'networkidle0' });
    
    // Palaukti, kad page įsikeltų
    await page.waitForTimeout(2000);
    
    // Pabandyti kelis email selector'ius
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]', 
      '#email',
      '.email-input',
      'input[placeholder*="email"]',
      'input[placeholder*="El. paštas"]'
    ];
    
    let emailInput = null;
    for (const selector of emailSelectors) {
      try {
        emailInput = await page.$(selector);
        if (emailInput) {
          console.log(`Found email input with selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!emailInput) {
      throw new Error('Email input not found with any selector');
    }
    
    await page.type(emailInput, email);
    
    // Submit button
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      '.submit-btn',
      '.login-btn',
      'button:contains("Prisijungti")'
    ];
    
    let submitButton = null;
    for (const selector of submitSelectors) {
      try {
        submitButton = await page.$(selector);
        if (submitButton) {
          console.log(`Found submit button with selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (submitButton) {
      await submitButton.click();
      await page.waitForNavigation({ waitUntil: 'networkidle0' });
    }
    
    // Password step
    await page.waitForTimeout(2000);
    
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      '#password',
      '.password-input'
    ];
    
    let passwordInput = null;
    for (const selector of passwordSelectors) {
      try {
        passwordInput = await page.$(selector);
        if (passwordInput) {
          console.log(`Found password input with selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (passwordInput) {
      await page.type(passwordInput, password);
      
      // Submit password
      const submitBtn = await page.$('button[type="submit"]') || await page.$('input[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForNavigation({ waitUntil: 'networkidle0' });
      }
    }
    
    // Scrape article
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForTimeout(3000);
    
    // Try multiple content selectors
    const contentSelectors = [
      '.article-content',
      '.article-body', 
      '.content',
      '.article-text',
      '.story-content',
      'article',
      '.post-content'
    ];
    
    let articleText = '';
    for (const selector of contentSelectors) {
      try {
        const content = await page.$(selector);
        if (content) {
          articleText = await page.evaluate(el => el.innerText, content);
          if (articleText && articleText.length > 100) {
            console.log(`Found content with selector: ${selector}`);
            break;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!articleText || articleText.length < 50) {
      throw new Error('Article content not found or too short');
    }
    
    return articleText;
    
  } catch (error) {
    console.error('Scraping error:', error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeVZArticle };
