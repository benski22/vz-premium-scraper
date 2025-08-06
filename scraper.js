const puppeteer = require('puppeteer');

// Helper function for delays - replaces page.waitForTimeout
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scrapeVZArticle(url, email, password) {
  const browser = await puppeteer.launch({ 
    headless: "new",
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });
  
  try {
    const page = await browser.newPage();
    
    // Set timeouts and user agent
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log('Accessing VZ login page...');
    
    // Go to login page
    await page.goto('https://prisijungimas.vz.lt/verslo-zinios', { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 
    });
    
    await delay(3000); // Fixed: was page.waitForTimeout(3000)
    console.log('Login page loaded');
    
    // CORRECTED: VŽ uses type="text" with id="email", not type="email"
    const emailSelectors = [
      '#email',                    // ✅ Exact match from HTML
      'input[id="email"]',         // ✅ Alternative exact match
      'input[type="text"][placeholder*="pašto"]', // ✅ By placeholder text
      'input[autocomplete="vzusername"]',         // ✅ VŽ specific autocomplete
      'input[type="text"]',        // ✅ Fallback generic
      'input[name="email"]'        // In case they use name attr
    ];
    
    let emailFound = false;
    for (const selector of emailSelectors) {
      try {
        console.log(`Trying email selector: ${selector}`);
        await page.waitForSelector(selector, { timeout: 5000 });
        await page.type(selector, email, { delay: 100 }); // Add typing delay
        console.log(`✅ Email entered successfully with: ${selector}`);
        emailFound = true;
        break;
      } catch (e) {
        console.log(`❌ Email selector failed: ${selector} - ${e.message}`);
        continue;
      }
    }
    
    if (!emailFound) {
      console.log('Taking screenshot for debugging...');
      await page.screenshot({ path: 'email-debug.png' });
      
      // Log all input elements for debugging
      const inputs = await page.$$eval('input', els => 
        els.map(el => ({
          id: el.id,
          type: el.type,
          name: el.name,
          placeholder: el.placeholder,
          class: el.className
        }))
      );
      console.log('Available inputs:', JSON.stringify(inputs, null, 2));
      
      throw new Error('Email input not found after trying all selectors');
    }
    
    // Submit email step
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]', 
      'button:contains("Tęsti")',
      '.btn-primary',
      'form button'
    ];
    
    let submitted = false;
    for (const selector of submitSelectors) {
      try {
        console.log(`Trying submit selector: ${selector}`);
        await page.click(selector);
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(`✅ Email submitted with: ${selector}`);
        submitted = true;
        break;
      } catch (e) {
        console.log(`❌ Submit failed: ${selector} - ${e.message}`);
        continue;
      }
    }
    
    if (!submitted) {
      console.log('Could not submit email form, trying without navigation wait...');
      try {
        await page.click('button[type="submit"]');
        await delay(3000); // Fixed: was page.waitForTimeout(3000)
        submitted = true;
      } catch (e) {
        console.log('Submit completely failed');
      }
    }
    
    // Password step (if we got to it)
    if (submitted) {
      console.log('Looking for password input...');
      await delay(2000); // Fixed: was page.waitForTimeout(2000)
      
      const passwordSelectors = [
        'input[type="password"]',
        '#password',
        'input[name="password"]'
      ];
      
      for (const selector of passwordSelectors) {
        try {
          console.log(`Trying password selector: ${selector}`);
          await page.waitForSelector(selector, { timeout: 10000 });
          await page.type(selector, password, { delay: 100 });
          console.log(`✅ Password entered with: ${selector}`);
          
          // Submit password
          await page.click('button[type="submit"]');
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
          console.log('✅ Password submitted successfully');
          break;
        } catch (e) {
          console.log(`❌ Password step failed: ${selector} - ${e.message}`);
          continue;
        }
      }
    }
    
    // Now access the article
    console.log(`Accessing article: ${url}`);
    
    let articleAccessSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, { 
          waitUntil: 'domcontentloaded',
          timeout: 60000 
        });
        articleAccessSuccess = true;
        break;
      } catch (error) {
        console.log(`Article access attempt ${attempt} failed:`, error.message);
        if (attempt < 3) {
          await delay(5000); // Fixed: was page.waitForTimeout(5000)
        }
      }
    }
    
    if (!articleAccessSuccess) {
      throw new Error('Could not access article page');
    }
    
    await delay(5000); // Fixed: was page.waitForTimeout(5000)
    
    // Extract content with multiple selectors
    const contentSelectors = [
      '.article-content',
      '.article-body', 
      '.content-body',
      'article .content',
      '[class*="article-content"]',
      '.story-content',
      'main article'
    ];
    
    let articleText = '';
    for (const selector of contentSelectors) {
      try {
        console.log(`Trying content selector: ${selector}`);
        const element = await page.$(selector);
        if (element) {
          const text = await page.evaluate(el => el.innerText, element);
          if (text && text.trim().length > 200) {
            articleText = text.trim();
            console.log(`✅ Content found with: ${selector} (${articleText.length} chars)`);
            break;
          }
        }
      } catch (e) {
        console.log(`❌ Content selector failed: ${selector}`);
        continue;
      }
    }
    
    // Fallback: extract all meaningful text
    if (!articleText || articleText.length < 100) {
      console.log('Trying fallback content extraction...');
      try {
        articleText = await page.evaluate(() => {
          // Remove unwanted elements
          const unwanted = document.querySelectorAll('script, style, nav, header, footer, .advertisement, .banner');
          unwanted.forEach(el => el.remove());
          
          // Try to find main content area
          const main = document.querySelector('main') || document.querySelector('.main') || document.body;
          return main.innerText || '';
        });
        console.log(`Fallback extraction: ${articleText.length} chars`);
      } catch (e) {
        console.log('Fallback extraction failed');
      }
    }
    
    if (!articleText || articleText.length < 50) {
      await page.screenshot({ path: 'article-debug.png' });
      throw new Error(`Article content too short or empty. Length: ${articleText.length}`);
    }
    
    console.log(`🎉 Article successfully extracted! Length: ${articleText.length} characters`);
    
    // Return first 8000 characters to avoid webhook size limits
    return articleText.substring(0, 8000);
    
  } catch (error) {
    console.error('❌ Scraping failed:', error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeVZArticle };
