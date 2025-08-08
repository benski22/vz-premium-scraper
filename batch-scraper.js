// batch-scraper.js
const puppeteer = require('puppeteer');
const axios = require('axios');

const articles = JSON.parse(process.env.ARTICLES);
const trendingTopics = process.env.TRENDING_TOPICS;
const webhookUrl = process.env.WEBHOOK_URL;

async function scrapeBatch() {
  const results = [];
  
  for (const article of articles) {
    try {
      // Tavo esamas scraping logic, bet be webhook call
      const scrapedText = await scrapeVZArticle(article.url);
      
      results.push({
        url: article.url,
        title: article.title,
        pubDate: article.pubDate,
        text: scrapedText,
        trending_topics: trendingTopics
      });
    } catch (error) {
      console.error(`Error scraping ${article.url}:`, error.message);
    }
  }
  
  // Vienas batch webhook call
  await axios.post(webhookUrl, { articles: results });
  console.log(`✅ Sent batch of ${results.length} articles to webhook`);
}

scrapeBatch();
