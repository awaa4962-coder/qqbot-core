import https from 'https';
import http from 'http';

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36' }
    }, (res) => {
      let data = '';
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetch(res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href));
      }
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

(async () => {
  try {
    // 1. Try saikr competition search
    console.log('=== SAIKR COMPETITIONS ===');
    const saikr = await fetch('https://www.saikr.com/vs?searchKey=' + encodeURIComponent('四川 2026 大学生 竞赛'));
    // Extract competition cards
    const titles = saikr.match(/class="title"[^>]*>([^<]+)/g);
    const times = saikr.match(/报名时间[：:][^<]*/g);
    if (titles) {
      titles.slice(0, 20).forEach((t, i) => {
        console.log(`${i+1}. ${t.replace(/<[^>]*>/g, '').trim()}`);
      });
    }
    if (times) {
      times.slice(0, 20).forEach(t => console.log('  ', t));
    }
  } catch(e) { console.error('saikr error:', e.message); }

  try {
    // 2. Try moocollege Sichuan competition platform
    console.log('\n=== MOOCOLLEGE SC ===');
    const mooc = await fetch('https://scxkjs.moocollege.com/');
    const comps = mooc.match(/<a[^>]*>[^<]*(?:大赛|竞赛|比赛)[^<]*<\/a>/g);
    if (comps) {
      comps.slice(0, 15).forEach(c => console.log('•', c.replace(/<[^>]*>/g, '').trim()));
    } else {
      // Try broader match
      const text = mooc.replace(/<[^>]*>/g, '\n').replace(/\n+/g, '\n').trim();
      const lines = text.split('\n').filter(l => /大赛|竞赛|比赛/.test(l));
      lines.slice(0, 20).forEach(l => console.log('•', l.trim()));
    }
  } catch(e) { console.error('mooc error:', e.message); }

  try {
    // 3. Try rssnsj - competition info site
    console.log('\n=== RSSNSJ ===');
    const rss = await fetch('https://www.rssnsj.org.cn/');
    const rcomps = rss.match(/<a[^>]*>[^<]*(?:大赛|竞赛|比赛)[^<]*<\/a>/g);
    if (rcomps) {
      rcomps.slice(0, 10).forEach(c => console.log('•', c.replace(/<[^>]*>/g, '').trim()));
    }
  } catch(e) { console.error('rssnsj error:', e.message); }

  try {
    // 4. Try searching baidu for competitions
    console.log('\n=== BAIDU SEARCH ===');
    const bd = await fetch('https://www.baidu.com/s?wd=' + encodeURIComponent('2026年四川省大学生竞赛 大专 高职 下半年 报名'));
    const bdLinks = bd.match(/<a[^>]*href="([^"]*)"[^>]*>([^<]*(?:大赛|竞赛|比赛|报名)[^<]*)<\/a>/g);
    if (bdLinks) {
      bdLinks.slice(0, 15).forEach(l => console.log('•', l.replace(/<[^>]*>/g, '').trim().substring(0, 120)));
    } else {
      console.log('no baidu results parsed');
    }
  } catch(e) { console.error('baidu error:', e.message); }

})();
