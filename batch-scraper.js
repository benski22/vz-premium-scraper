// batch_js_merged_preferred_logs.js
/**
 * VZ / ManoPinigai batch scraper for n8n "Wait (On Webhook call)" architecture.
 * n8n must inject per-execution resume URL into ENV WEBHOOK_URL (use {{$execution.resumeUrl}}).
 * Optional auth:
 *  - Token via header (WEBHOOK_HEADER_NAME, default X-Webhook-Token) and/or query (?token=...)
 *  - Basic auth via WEBHOOK_BASIC_USER / WEBHOOK_BASIC_PASS
 * Strictness:
 *  - STRICT_WEBHOOK = "true" makes POST failure fail the job (process.exit(1)).
 */

const puppeteer = require('puppeteer');
const axios = require('axios');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ----- Logs like OLD version -----
console.log('OPTIMIZED BATCH ENV:', {
  articlesCount: (() => { try { return JSON.parse(process.env.ARTICLES || '[]').length; } catch { return 0; } })(),
  trendingTopics: process.env.TRENDING_TOPICS ? 'Present' : 'Missing',
  webhook: process.env.WEBHOOK_URL
});

// ----- Helpers -----
function getDomainType(url) { return url.includes('manopinigai.vz.lt') ? 'manopinigai' : 'vz'; }
function groupArticlesByDomain(articles) {
  const vzArticles = articles.filter(a => getDomainType(a.url) === 'vz');
  const manoPinigaiArticles = articles.filter(a => getDomainType(a.url) === 'manopinigai');
  return { vzArticles, manoPinigaiArticles };
}

async function postToWebhookWithFallbacks(baseUrl, data) {
  const token = process.env.WEBHOOK_TOKEN || '';
  const headerName = process.env.WEBHOOK_HEADER_NAME || 'X-Webhook-Token';
  const basicUser = process.env.WEBHOOK_BASIC_USER || '';
  const basicPass = process.env.WEBHOOK_BASIC_PASS || '';

  const tryUrls = [];
  // 1) base + token query (jei token yra)
  if (token) {
    tryUrls.push(baseUrl.includes('?') ? `${baseUrl}&token=${encodeURIComponent(token)}` : `${baseUrl}?token=${encodeURIComponent(token)}`);
  }
  // 2) base be query
  tryUrls.push(baseUrl);

  const headersList = [];
  // a) su header token (jei token yra)
  if (token) headersList.push({ [headerName]: token });
  // b) be header token
  headersList.push({});

  const axiosBase = {
    timeout: 20000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: (s) => s >= 200 && s < 300, // kaip „old“ – non-2xx = klaida
  };
  if (basicUser && basicPass) axiosBase.auth = { username: basicUser, password: basicPass };

  let lastErr;
  for (const url of tryUrls) {
    for (const headers of headersList) {
      try {
        const res = await axios.post(url, data, { ...axiosBase, headers: { 'Content-Type': 'application/json', ...headers } });
        return res;
      } catch (e) {
        lastErr = e;
        console.warn(`POST attempt failed to ${url} with headers=${Object.keys(headers).join(',') || 'none'}: ${e.message}`);
        await delay(1000);
      }
    }
  }
  throw lastErr;
}

// ----- Auth -----
async function performLogin(page, email, password, domainType) {
  console.log(`🔐 Logging into ${domainType === 'manopinigai' ? 'Mano Pinigai' : 'VZ'}...`);
  const loginUrl = domainType === 'manopinigai'
    ? 'https://prisijungimas.vz.lt/mano-pinigai'
    : 'https://prisijungimas.vz.lt/verslo-zinios';

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await delay(2000);

  const emailSelectors = ['#email','input[id="email"]','input[type="text"][placeholder*="pašto"]','input[autocomplete="vzusername"]','input[type="text"]','input[name="email"]'];
  let emailFound = false;
  for (const s of emailSelectors) {
    try { await page.waitForSelector(s, { timeout: 5000 }); await page.type(s, email, { delay: 50 }); emailFound = true; break; } catch {}
  }
  if (!emailFound) throw new Error('Email input not found');

  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });

  const passwordSelectors = ['input[type="password"]','#password','input[name="password"]'];
  let pwOk = false;
  for (const s of passwordSelectors) {
    try {
      await page.waitForSelector(s, { timeout: 10000 });
      await page.type(s, password, { delay: 50 });
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
      pwOk = true; break;
    } catch {}
  }
  if (!pwOk) throw new Error('Password input not found');

  console.log(`✅ Successfully logged into ${domainType === 'manopinigai' ? 'Mano Pinigai' : 'VZ'}`);
}

// ----- Extraction (su stabilumo retry) -----
async function extractArticleContent(page, url, domainType) {
  console.log(`📖 Extracting content from: ${url}`);

  // mažas helperis prieš evaluate – pasiruošiam
  const safeGoto = async () => {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    // ManoPinigai – dažniau lifecycles/perskydimai
    await delay(domainType === 'manopinigai' ? 2000 : 1000);
  };

  const attempt = async () => {
    await safeGoto();

    if (domainType === 'manopinigai') {
      const isLoginPage = await page.evaluate(() =>
        window.location.href.includes('prisijungimas') ||
        document.querySelector('input[type="password"]') !== null
      );
      if (isLoginPage) throw new Error('Still on login page - session might have expired');
    }

    const articleText = await page.evaluate((domainType) => {
      let content = '';
      const unwanted = [
        '.infogram-embed','.sas','.has-ad-desktop','.rekvizitai-embed',
        'iframe[src*="infogram"]','iframe[src*="rekvizitai"]',
        'figure.infogram-embed','figure.rekvizitai-embed',
        '.author-disclaimer','.suggestion-form','form',
        '.article-social-links','.article-comments',
        'script','style','nav','header','footer',
        '.advertisement','.banner','figcaption',
        '.w-full.bg-vzGrey-2','.additional-info',
        '[id^="sas_"]'
      ];
      unwanted.forEach(sel => document.querySelectorAll(sel).forEach(el => el.remove()));

      if (domainType === 'manopinigai') {
        let ck = document.querySelector('.ck-content.paywall') ||
                 document.querySelector('.ck-content') ||
                 document.querySelector('.article-content .ck-content') ||
                 document.querySelector('.article-content');
        if (ck) {
          const nodes = ck.querySelectorAll('p, h2, h3, h4, strong');
          let stop = false;
          nodes.forEach(el => {
            if (stop) return;
            const text = el.textContent?.trim();
            if (!text || text.length < 3) return;
            if (text.includes('DAUGIAU SKAITYKITE') ||
                text.includes('SUSIJĘ STRAIPSNIAI') ||
                text.includes('TAIP PAT SKAITYKITE')) { stop = true; return; }
            if (text.includes('Prenumeruoti') || text.includes('Prisijungti') ||
                text.includes('Norite pasiūlyti temą') || text.includes('redaktoriams') ||
                text.includes('nuotr.') || text.includes('koliažas')) return;

            if (['H2','H3','H4'].includes(el.tagName))       content += '\n' + text + '\n\n';
            else if (el.tagName === 'STRONG' && el.parentNode?.tagName === 'P' && text.length > 50) content += text + '\n\n';
            else if (el.tagName === 'P')                      content += text + '\n\n';
          });
        }
      } else {
        const summary = document.querySelector('summary');
        if (summary) content += summary.textContent.trim() + '\n\n';
        const ps = document.querySelectorAll('.content-paragraph');
        ps.forEach(p => {
          if (p.querySelector('i')) return;
          const strong = p.querySelector('strong');
          const pt = p.textContent?.trim();
          if (strong && pt === strong.textContent.trim() && strong.textContent.trim().length > 5) {
            content += strong.textContent.trim() + '\n\n';
            return;
          }
          let text = '';
          Array.from(p.childNodes).forEach(n => {
            if (n.nodeType === Node.TEXT_NODE) text += n.textContent;
            else if (n.nodeType === Node.ELEMENT_NODE) {
              if (n.tagName === 'A') text += n.textContent;
              else if (n.tagName !== 'I') text += n.textContent;
            }
          });
          const clean = (text || '').trim();
          if (clean && clean.length > 10) content += clean + '\n\n';
        });
      }

      if (!content || content.trim().length < 100) {
        const fallbacks = ['.article-content','.article-body','.content-body','article .content','main article','.post-content','.entry-content'];
        for (const sel of fallbacks) {
          const el = document.querySelector(sel);
          if (el) {
            const t = el.innerText || el.textContent || '';
            if (t.trim().length > 200) { content = t.trim(); break; }
          }
        }
      }
      return (content || '').trim();
    }, domainType);

    let finalText = articleText;
    if (!finalText || finalText.length < 100) {
      finalText = await page.evaluate(() => {
        const bt = document.body.innerText || document.body.textContent || '';
        const paras = bt.split('\n').filter(line => {
          const t = line.trim();
          return t.length > 50 && !t.includes('Prenumeruoti') && !t.includes('Prisijungti') &&
                 !t.includes('nuotr.') && !t.includes('koliažas') && !t.includes('© VŽ');
        });
        return paras.slice(0, 20).join('\n\n');
      });
    }
    if (!finalText || finalText.length < 50) throw new Error(`Article content too short (${finalText?.length || 0} chars) - might be behind paywall`);

    console.log(`📝 Content preview: ${finalText.substring(0, 150)}...`);
    console.log(`📊 Content length: ${finalText.length} characters`);

    const maxLength = 20000;
    if (finalText.length > maxLength) {
      console.log(`⚠️  Content truncated from ${finalText.length} to ${maxLength} characters`);
      finalText = finalText.substring(0, maxLength);
    }
    return finalText;
  };

  // Retry ant žinomos Puppeteer bėdos
  // „Execution context was destroyed, most likely because of a navigation.“
  for (let r = 1; r <= 3; r++) {
    try {
      if (r > 1) console.log(`🔁 Retrying (${r}/3) due to navigation/context issue...`);
      return await attempt();
    } catch (e) {
      if (e.message && e.message.includes('Execution context was destroyed')) {
        // hard reload
        try { await page.reload({ waitUntil: 'networkidle2' }); } catch {}
        await delay(800);
        continue;
      }
      // kitos klaidos – nelekiam lauk, o metame toliau; išorinis catch nuspręs
      throw e;
    }
  }
  throw new Error('Extraction failed after 3 attempts');
}

// ----- Batch by domain -----
async function scrapeArticlesByDomain(articles, domainType, email, password, trendingTopics) {
  if (!articles?.length) { console.log(`📋 No ${domainType} articles to process`); return []; }
  console.log(`🚀 Starting ${domainType} batch: ${articles.length} articles`);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
  const results = [];
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await performLogin(page, email, password, domainType);

    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      try {
        console.log(`[${i + 1}/${articles.length}] ${domainType.toUpperCase()}: ${a.title?.substring(0,50)}...`);
        const text = await extractArticleContent(page, a.url, domainType);
        results.push({ url: a.url, title: a.title, pubDate: a.pubDate, text, trending_topics: trendingTopics });
        console.log(`✅ [${i + 1}/${articles.length}] Successfully scraped ${domainType} article`);
        if (i < articles.length - 1) { console.log('⏳ Waiting 1 second before next article...'); await delay(1000); }
      } catch (e) {
        console.error(`❌ [${i + 1}/${articles.length}] Error scraping ${a.url}: ${e.message}`);
        if (e.message.includes('session') || e.message.includes('login')) {
          console.log('🔄 Attempting to re-login...');
          try { await performLogin(page, email, password, domainType); console.log('✅ Re-login successful, continuing...'); }
          catch (re) { console.error('❌ Re-login failed:', re.message); /* NESUSTOJAM – tęsiam kitus straipsnius */ }
        }
      }
    }
  } catch (e) {
    console.error(`💥 Critical error in ${domainType} batch:`, e.message);
  } finally {
    await browser.close();
  }
  console.log(`📊 ${domainType.toUpperCase()} batch complete: ${results.length}/${articles.length} articles scraped`);
  return results;
}

// ----- Full batch -----
async function scrapeBatchOptimized() {
  let articles = [];
  try { articles = JSON.parse(process.env.ARTICLES || '[]'); } catch {}
  const trendingTopics = process.env.TRENDING_TOPICS || '';
  const webhookUrl = process.env.WEBHOOK_URL; // MUST be $execution.resumeUrl
  if (!webhookUrl) throw new Error('WEBHOOK_URL is missing');

  console.log(`🎯 Starting OPTIMIZED batch scraping for ${articles.length} articles`);
  const { vzArticles, manoPinigaiArticles } = groupArticlesByDomain(articles);
  console.log(`📊 Domain distribution: ${vzArticles.length} VZ articles, ${manoPinigaiArticles.length} ManoPinigai articles`);

  const allResults = [];
  if (vzArticles.length) allResults.push(...await scrapeArticlesByDomain(vzArticles, 'vz', process.env.VZ_EMAIL, process.env.VZ_PASSWORD, trendingTopics));
  if (manoPinigaiArticles.length) allResults.push(...await scrapeArticlesByDomain(manoPinigaiArticles, 'manopinigai', process.env.VZ_EMAIL, process.env.VZ_PASSWORD, trendingTopics));

  console.log(`🎉 OPTIMIZED batch complete: ${allResults.length}/${articles.length} articles scraped successfully`);

  // Payload kaip "old", + trending_topics jei reikia toliau
  const payload = { articles: allResults, trending_topics: trendingTopics };

  if (allResults.length > 0) {
    try {
      const res = await postToWebhookWithFallbacks(webhookUrl, payload);
      console.log(`🚀 Successfully sent batch of ${allResults.length} articles to webhook; response ${res.status}`);
    } catch (e) {
      const strict = String(process.env.STRICT_WEBHOOK || 'false').toLowerCase() === 'true';
      console.error('❌ Failed to send batch to webhook:', e.message);
      if (strict) throw e; // tik jei reik, kad job'as kristų
    }
  } else {
    console.log('⚠️ No articles scraped successfully - nothing to send');
  }
}

// ----- Main -----
(async () => {
  try { await scrapeBatchOptimized(); console.log('🎉 OPTIMIZED batch scraping completed successfully'); }
  catch (e) { console.error('💥 OPTIMIZED batch scraping failed:', e.message); process.exit(1); }
})();
