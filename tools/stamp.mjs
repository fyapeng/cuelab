// 发布前给所有资源地址加版本号，防止浏览器把新旧版本的文件混在一起用。
//
// 网站的静态文件会被浏览器和 CDN 缓存数小时。如果新的 index.html 配上缓存里旧的 main.js，
// 或者新的 main.js 配上旧的 presets.js，页面就会缺功能甚至报错。
// 这里把 index.html 里的 main.js / style.css、所有模块之间的相对 import、以及 Worker 地址
// 都改成 “xxx.js?v=<版本>”：每次发布都是一组全新的地址，同一版本的文件总是成套加载。
//
// 用法：node tools/stamp.mjs <版本> [目录]    （默认就地修改当前目录，CI 里对发布副本运行）

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2] || Date.now().toString(36);
const root = process.argv[3] || '.';
const tag = (m, pre, path, _old, post) => `${pre}${path}?v=${version}${post}`;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) {
      const src = readFileSync(p, 'utf8');
      const out = src
        .replace(/(\bfrom\s+['"])(\.{1,2}\/[^'"?]+\.js)(\?v=[^'"]*)?(['"])/g, tag)
        .replace(/(\bimport\s+['"])(\.{1,2}\/[^'"?]+\.js)(\?v=[^'"]*)?(['"])/g, tag)
        .replace(/(new URL\(\s*['"])(\.{1,2}\/[^'"?]+\.js)(\?v=[^'"]*)?(['"])/g, tag);
      if (out !== src) writeFileSync(p, out);
    }
  }
}

walk(join(root, 'src'));
const html = join(root, 'index.html');
writeFileSync(
  html,
  readFileSync(html, 'utf8').replace(/((?:src|href)=")(src\/[^"?]+\.(?:js|css))(\?v=[^"]*)?(")/g, tag)
);
console.log(`已加版本号 v=${version}`);
