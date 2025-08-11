/**
 * VZ / ManoPinigai batch scraper for n8n "Wait (On Webhook call)" architecture.
 * IMPORTANT: n8n must inject the per-execution resume URL into ENV WEBHOOK_URL (use {{$execution.resumeUrl}}).
 * Optional WEBHOOK_TOKEN is appended as ?token=... and sent as X-Webhook-Token header.
 */

console.log('OPTIMIZED BATCH ENV:', {
  articlesCount: (() => { try { return JSON.parse(process.env.ARTICLES || '[]').length; } catch { return 0; } })(),
  trendingTopics: process.env.TRENDING_TOPICS ? 'Present' : 'Missing',
  webhook: process.env.WEBHOOK_URL,
});

const puppeteer = require('puppeteer');
const axios = require('axios');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getDomainType(url) { return url.includes('manopinigai.vz.lt') ? 'manopinigai' : 'vz'; }
function groupArticlesByDomain(articles) {
  const vzArticles = articles.filter(a => getDomainType(a.url) === 'vz');
  const manoPinigaiArticles = articles.filter(a => getDomainType(a.url) === 'manopinigai');
  return { vzArticles, manoPinigaiArticles };
}

async function httpPostWithRetry(url, data, headers = {}, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await axios.post(url, data, {
        headers: { 'Content-Type': 'application/json', ...headers },
        timeout: 20000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: s => s >= 200 && s < 500,
      });
      if (res.status >= 200 && res.status < 300) return res;
      lastErr = new Error(`HTTP ${res.status}: ${JSON.stringify(res.data)?.slice(0,500)}`);
      console.warn(`POST attempt ${i}/${attempts} failed: ${lastErr.message}`);
      await delay(1000 * i);
    } catch (e) {
      lastErr = e;
      console.warn(`POST attempt ${i}/${attempts} error: ${e.message}`);
      await delay(1000 * i);
    }
  }
  throw lastErr;
}

async function performLogin(page, email, password, domainType) {
  console.log(`🔐 Logging into ${domainType === 'manopinigai' ? 'Mano Pinigai' : 'VZ'}...`);
  const loginUrl = domainType === 'manopinigai'
    ? 'https://prisijungimas.vz.lt/mano-pinigai'
    : 'https://prisijungimas.vz.lt/verslo-zinios';

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await delay(1500);

  const emailSelectors = ['#email','input[id="email"]','input[type="text"][placeholder*="pašto"]','input[autocomplete="vzusername"]','input[type="text"]','input[name="email"]'];
  let emailFound = false;
  for (const s of emailSelectors) {
    try { await page.waitForSelector(s, { timeout: 5000 }); await page.type(s, email, { delay: 30 }); emailFound = true; break; } catch {}
  }
  if (!emailFound) throw new Error('Email input not found');

  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });

  const passwordSelectors = ['input[type="password"]','#password','input[name="password"]'];
  let pwOk = false;
  for (const s of passwordSelectors) {
    try {
      await page.waitForSelector(s, { timeout: 10000 });
      await page.type(s, password, { delay: 30 });
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
      pwOk = true; break;
    } catch {}
  }
  if (!pwOk) throw new Error('Password input not found');

  console.log(`✅ Logged in to ${domainType === 'manopinigai' ? 'Mano Pinigai' : 'VZ'}`);
}

async function extractArticleContent(page, url, domainType) {
  console.log(`📖 Extracting content from: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (domainType === 'manopinigai') {
      const isLoginPage = await page.evaluate(() =>
        window.location.href.includes('prisijungimas') ||
        document.querySelector('input[type="password"]') !== null
      );
      if (isLoginPage) throw new Error('Still on login page - session might have expired');
      await delay(1200);
    } else {
      await delay(800);
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
    if (!finalText || finalText.length < 50) throw new Error(`Article content too short (${finalText?.length || 0}) - paywall?`);

    const maxLength = 20000;
    if (finalText.length > maxLength) { console.log(`⚠️ Content truncated: ${finalText.length} -> ${maxLength}`); finalText = finalText.substring(0, maxLength); }

    return finalText;
  } catch (e) {
    console.error(`❌ Extract failed ${url}: ${e.message}`);
    throw e;
  }
}

async function scrapeArticlesByDomain(articles, domainType, email, password, trendingTopics) {
  if (!articles?.length) { console.log(`📋 No ${domainType} articles`); return []; }
  console.log(`🚀 ${domainType} batch: ${articles.length} articles`);

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
        console.log(`[${i + 1}/${articles.length}] ${domainType.toUpperCase()}: ${a.title?.slice(0,50)}...`);
        const text = await extractArticleContent(page, a.url, domainType);
        results.push({ url: a.url, title: a.title, pubDate: a.pubDate, text, trending_topics: trendingTopics });
        console.log(`✅ Scraped ${domainType} #${i + 1}`);
        if (i < articles.length - 1) { await delay(1000); }
      } catch (e) {
        console.error(`❌ Error on ${a.url}: ${e.message}`);
        if (e.message.includes('session') || e.message.includes('login')) {
          console.log('🔄 Re-login attempt...');
          try { await performLogin(page, email, password, domainType); console.log('✅ Re-login successful'); }
          catch (re) { console.error('❌ Re-login failed:', re.message); break; }
        }
      }
    }
  } catch (e) {
    console.error(`💥 Critical ${domainType} batch error:`, e.message);
  } finally {
    await browser.close();
  }
  console.log(`📊 ${domainType.toUpperCase()} batch done: ${results.length}/${articles.length}`);
  return results;
}

async function scrapeBatchOptimized() {
  let articles = [];
  try { articles = JSON.parse(process.env.ARTICLES || '[]'); } catch {}
  const trendingTopics = process.env.TRENDING_TOPICS || '';
  const webhookBase = process.env.WEBHOOK_URL; // MUST be n8n $execution.resumeUrl
  const webhookToken = process.env.WEBHOOK_TOKEN || '';
  if (!webhookBase) throw new Error('WEBHOOK_URL is missing');

  const webhookUrl = webhookToken
    ? (webhookBase.includes('?') ? `${webhookBase}&token=${encodeURIComponent(webhookToken)}` : `${webhookBase}?token=${encodeURIComponent(webhookToken)}`)
    : webhookBase;

  console.log(`🎯 Starting batch for ${articles.length} articles`);
  const { vzArticles, manoPinigaiArticles } = groupArticlesByDomain(articles);
  console.log(`📊 Domain split: VZ=${vzArticles.length} | ManoPinigai=${manoPinigaiArticles.length}`);

  const allResults = [];
  if (vzArticles.length) allResults.push(...await scrapeArticlesByDomain(vzArticles, 'vz', process.env.VZ_EMAIL, process.env.VZ_PASSWORD, trendingTopics));
  if (manoPinigaiArticles.length) allResults.push(...await scrapeArticlesByDomain(manoPinigaiArticles, 'manopinigai', process.env.VZ_EMAIL, process.env.VZ_PASSWORD, trendingTopics));

  console.log(`🎉 Batch complete: ${allResults.length}/${articles.length} scraped successfully`);

  const payload = { articles: allResults, trending_topics: trendingTopics, body: { articles: allResults, trending_topics: trendingTopics } };
  if (allResults.length) {
    try {
      const headers = webhookToken ? { 'X-Webhook-Token': webhookToken } : {};
      const res = await httpPostWithRetry(webhookUrl, payload, headers, 3);
      console.log(`🚀 Sent ${allResults.length} articles to webhook. Response: ${res.status}`);
    } catch (e) {
      console.error('❌ Failed to POST to webhook:', e.message);
      throw e;
    }
  } else {
    console.log('⚠️ No successful articles to send');
  }
}

(async () => {
  try { await scrapeBatchOptimized(); console.log('✅ OPTIMIZED batch scraping completed'); }
  catch (e) { console.error('💥 OPTIMIZED batch scraping failed:', e.message); process.exit(1); }
})();
