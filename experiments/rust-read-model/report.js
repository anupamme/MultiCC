#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path');
const [baseFile, indexedFile, markdownFile, htmlFile, rawUrl, indexedUrl] = process.argv.slice(2);
if (!htmlFile) throw new Error('用法：node report.js 基准.json 索引.json 报告.md 预览.html [基准下载链接] [索引下载链接]');
const base = JSON.parse(fs.readFileSync(baseFile, 'utf8')), indexed = JSON.parse(fs.readFileSync(indexedFile, 'utf8'));
const labels = { current: '现有 Node', incremental: '增量 Node', worker: 'Node 工作线程', rust: 'Rust 异步' };
const kinds = Object.keys(labels), md = [], html = [];
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = n => n < .01 ? n.toFixed(4) : n.toFixed(2);
const row = (report, n, kind) => report.results.find(r => r.count === n && r.kind === kind);
const time = (report, n, kind, key) => row(report, n, kind).cases[key].elapsedMs.median;
const factor = (a, b) => (a / b).toFixed(2);
function heading(title, level = 2) { md.push('#'.repeat(level) + ' ' + title, ''); html.push(`<h${level}>${escape(title)}</h${level}>`); }
function p(text) { md.push(text, ''); html.push(`<p>${escape(text)}</p>`); }
function table(headers, rows) {
  md.push('| ' + headers.join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |', ...rows.map(r => '| ' + r.join(' | ') + ' |'), '');
  html.push('<div class="table"><table><thead><tr>' + headers.map(x => `<th>${escape(x)}</th>`).join('') + '</tr></thead><tbody>'
    + rows.map(r => '<tr>' + r.map(x => `<td>${escape(x)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
}
function code(text) { md.push('```bash', text, '```', ''); html.push('<pre>' + escape(text) + '</pre>'); }

heading('Rust 任务读模型模拟评测 · 2026-10-22', 1);
p('结论：有针对性的 Rust 后台读取值得进入下一轮验证，但不建议整体切换。最有价值的边界是“Rust 直接读取 SQLite 的原始记录 → 提取卡片摘要 → 持有读模型”，避免大段上下文变成 JS 对象再搬回 Rust。普通缓存命中、日常写入和小规模卡片更新暂时保留 Node 更合适。所有实验均在隔离进程和临时数据库中完成，生产路由、数据库、原生模块入口和配置未修改。');
heading('测试范围与公平基线');
p(`环境：${base.environment.cpu}，${base.environment.platform}/${base.environment.arch}，Darwin ${base.environment.os}，Node ${base.environment.node}，${base.environment.rust}。源码基线 ${base.environment.commit}。测试时间 ${base.environment.at}（UTC）。未在 2013 Intel MacBook 上测试。`);
p('四种实现：直接使用现有 createAirReadIndex；独立的增量 Node 原型；相同增量 Node 在工作线程中运行；通过 napi-rs AsyncTask 调用的 Rust 原型。两种增量实现均采用映射表、有序数组、增减计数和有界分页缓存，大批变更才重新排序。Rust 已使用固定字段结构，并跳过摘要不需要的正文解析；它不是通用 JSON 对象版本的初稿。');
p('数据规模为 100、1277、3000、10000 条。每条任务包含 8192 字符上下文、4 条引用，分布在 10 个目录，包含运行、等待、出错、完成、归档、待办、忽略和置顶等状态。数据全部为合成数据。');
p(`每场景预热 2 次、测量 ${base.method.rounds} 次，表中是中位数，单位为毫秒。每种后端与数据规模使用独立进程，依次运行，不同规模轮换后端顺序。原始文件保留 P95、最大值、CPU 时间和主线程心跳。系统文件缓存预热，不是物理磁盘冷启动；本机其他程序可能影响尾部延迟，15 个样本不足以作为生产 P95 服务指标。`);
p(`Node 使用 SQLite ${row(base, 3000, 'current').sqlite}，Rust 使用 SQLite ${row(base, 3000, 'rust').sqlite}。SQL、表结构、数据和 WAL/NORMAL 设置相同，但 SQLite 版本不同，数据库倍数不能全部归因于编程语言。`);
p('计时包含主线程参数编码、跨线程/原生边界、排队、后台计算及结果解码。摘要构建还包含 Node 将源记录投影为卡片的时间。Node 直接调用无需额外跨语言拷贝；工作线程与 Rust 使用相同 JSON 请求边界。SQL 写入使用同一事务和同样的完整记录，未模拟完整业务层的权属、收据和二级索引联动。');
heading('卡片构建、缓存与增量更新');
const cardCases = { compactBuild: '摘要首次构建', unchangedSnapshot: '全量未变化快照校验', cachedPage: '分页缓存命中',
  uncachedPage: '未命中缓存的分页', singleUpdate: '单卡更新', singleUpdateAndRead: '单卡更新＋分页＋统计', batch100AndRead: '100 张卡变更＋分页＋统计' };
for (const count of [100, 1277, 3000, 10000]) {
  heading(`${count} 条任务`, 3);
  table(['场景', ...kinds.map(k => labels[k])], Object.entries(cardCases).map(([key, title]) => [title, ...kinds.map(k => number(time(base, count, k, key)))]));
}
p(`在 1277 条任务时，单卡更新从现有 Node 的 ${number(time(base,1277,'current','singleUpdate'))}ms 降到 Rust 的 ${number(time(base,1277,'rust','singleUpdate'))}ms；但增量 Node 为 ${number(time(base,1277,'incremental','singleUpdate'))}ms。因此不能把相对旧实现的全部提升称为 Rust 语言加速。`);
p(`3000 条任务的“更新＋分页＋统计”：现有 Node ${number(time(base,3000,'current','singleUpdateAndRead'))}ms，增量 Node ${number(time(base,3000,'incremental','singleUpdateAndRead'))}ms，Rust ${number(time(base,3000,'rust','singleUpdateAndRead'))}ms。Rust 相对增量 Node 为 ${factor(time(base,3000,'incremental','singleUpdateAndRead'),time(base,3000,'rust','singleUpdateAndRead'))} 倍，绝对节省 ${number(time(base,3000,'incremental','singleUpdateAndRead')-time(base,3000,'rust','singleUpdateAndRead'))}ms。首次构建、全量缓存校验、缓存命中则没有一致优势。`);
heading('为什么不能把整份任务对象反复传给 Rust');
table(['任务数', '源数据 MiB', '摘要 MiB', '现有 Node 构建', 'Rust 接收完整源记录', 'Rust 接收摘要'], [1277,3000,10000].map(n => [n,
  (row(base,n,'rust').sourceBytes/1048576).toFixed(2),(row(base,n,'rust').cardBytes/1048576).toFixed(2),
  number(time(base,n,'current','fullSourceBuild')),number(time(base,n,'rust','fullSourceBuild')),number(time(base,n,'rust','compactBuild'))]));
p('Rust 后台执行不代表整个请求不阻塞主线程。完整记录先在 Node 里 JSON.stringify，这部分仍在主线程；把大量不需要的上下文搬过去会抵消后台计算的收益。生产设计必须传增量或直接由后台读取存储。');
heading('数据库：先排除临时排序，再看 Rust 直接读取的收益');
p('现有 shell_records 的主键为 (kind,id)，查询使用 WHERE kind=\'task\' ORDER BY rowid。EXPLAIN QUERY PLAN 显示 USE TEMP B-TREE FOR ORDER BY。模拟库增加 CREATE INDEX experiment_kind_rowid ON shell_records(kind) 后，SQLite 可利用索引中隐含的 rowid 顺序，临时排序消失。该索引没有加入正式数据库。');
table(['同样附加索引', '最快已测 Node 路径 / ms', 'Rust 直接读取并构建 / ms', '加速比'], [1277,3000,10000].map(n => {
  const best = Math.min(...['current','incremental','worker'].flatMap(k => ['dbFullLoad','dbProjectedLoad'].map(c => time(indexed,n,k,c))));
  const native = time(indexed,n,'rust','dbFullLoad');
  return [n+' 条任务',number(best),number(native),factor(best,native)+' 倍'];
}));
p('上表按规模选择本次最快的 Node 路径（包含工作线程，可能选择不同方案），两侧输出相同摘要读模型；不是拿全表 Node 与已经加索引的 Rust 混比。下面保留所有分项，便于核对。');
for (const count of [1277,3000,10000]) {
  heading(`${count} 条任务的数据库读取及读模型构建`,3);
  table(['结构与查询', ...kinds.map(k=>labels[k])], [
    ['原结构，全记录读取',...kinds.map(k=>number(time(base,count,k,'dbFullLoad')))],
    ['原结构，只返回摘要',...kinds.map(k=>number(time(base,count,k,'dbProjectedLoad')))],
    ['附加索引，全记录读取',...kinds.map(k=>number(time(indexed,count,k,'dbFullLoad')))],
    ['附加索引，只返回摘要',...kinds.map(k=>number(time(indexed,count,k,'dbProjectedLoad')))],
  ]);
}
p(`同样增加查询索引后，3000 条任务的 Rust 原始记录读取＋摘要构建为 ${number(time(indexed,3000,'rust','dbFullLoad'))}ms；本次最佳 Node 同线程方案是 SQL 摘要投影＋增量模型，为 ${number(time(indexed,3000,'incremental','dbProjectedLoad'))}ms，Rust 约快 ${factor(time(indexed,3000,'incremental','dbProjectedLoad'),time(indexed,3000,'rust','dbFullLoad'))} 倍。10000 条时为 ${number(time(indexed,10000,'rust','dbFullLoad'))}ms 对 ${number(time(indexed,10000,'incremental','dbProjectedLoad'))}ms，约 ${factor(time(indexed,10000,'incremental','dbProjectedLoad'),time(indexed,10000,'rust','dbFullLoad'))} 倍。`);
p('这不是单纯把 SQLite 从 Node 换成 Rust 的收益：Rust 在后台用固定结构选择性解析 JSON，大段上下文不会被构造成 V8 对象，摘要也留在 Rust 内。SQL 层逐字段提取并非总是最优；Rust 在此数据集上直接读取原始 JSON、忽略无关字段，比让 SQLite 逐字段生成摘要更快。所有倍数仅代表这几种已测实现，不能当成 Rust 对任何 Node 实现的通用倍数。');
table(['附加索引后的事务',...kinds.map(k=>labels[k])],[['3000 条库，写 1 条',...kinds.map(k=>number(time(indexed,3000,k,'dbWriteOne')))],
  ['3000 条库，批量写 100 条',...kinds.map(k=>number(time(indexed,3000,k,'dbWrite100')))]]);
p('查询投影由同一 SQL 从原始 JSON 提取字段及引用时间，没有额外预建摘要表。写入测试保留完整上下文，并验证事务失败回滚及关闭后重新读取。现有 Node、增量 Node 的数据库写入实现相同，它们之间的波动不代表算法差异。附加索引会增加空间和写入维护成本；这里只观察有限次更新，尚未覆盖大批新增、删除或正式迁移。');
heading('主线程响应性与内存');
table(['3000 条任务场景：最大心跳间隔的中位数',...kinds.map(k=>labels[k])],[
  ['摘要构建',...kinds.map(k=>number(row(base,3000,k).cases.compactBuild.heartbeatMaxGapMs.median))],
  ['原结构全记录数据库读取',...kinds.map(k=>number(row(base,3000,k).cases.dbFullLoad.heartbeatMaxGapMs.median))],
  ['附加索引全记录数据库读取',...kinds.map(k=>number(row(indexed,3000,k).cases.dbFullLoad.heartbeatMaxGapMs.median))],
]);
p('心跳使用 1ms 定时器，约 1～2ms 是本机定时器及调度噪声。后台数据库读不会让主线程同步等待整个 SQL 操作；Node 工作线程也能提供这一优势。主线程编码大请求仍可能造成长停顿。此探针不是 HTTP、WebSocket 或页面渲染的端到端测试。');
table(['完整模拟过程峰值 RSS / MiB',...kinds.map(k=>labels[k])],[3000,10000].map(n=>[n+' 条任务',...kinds.map(k=>row(base,n,k).memory.peakRssMiB.toFixed(1))]));
p('RSS 为整个独立进程，包含合成数据、Node、SQLite、Rust或工作线程，以及多轮测试产生的临时分配；不能当作某一个库的精确内存占用。工作线程还包含额外的 V8 堆。Rust 在所有规模上并未稳定小于增量 Node，不能据此承诺省内存。');
heading('正确性与尚未覆盖的生产契约');
p('已通过 318 组逐字段对照，每组比较四种后端，覆盖重复快照、原地变更、跨目录变化、删除、空列表、所有模拟筛选、中文与 emoji 标题、置顶、访问排序、指定 ID 排序、同时间排序以及统计。数据库原结构和附加索引结构均通过全记录/摘要等价、批量写入、失败回滚、重新打开、完整上下文未丢失检查，共 3 个测试用例。Rust 格式检查和 Clippy 严格检查通过，JavaScript 语法检查通过。');
p('这是有限合同的模拟，不是可直接替换的生产实现。尚未实现或完整验证权限判断、Git 状态、动态容量、派发时间宽限、跨连接变更通知、WebSocket 游标与重放、并发命令顺序、崩溃恢复、升级回滚及所有异常输入。输入 ID 使用固定 ASCII 格式、时间使用有效整数；不能据此推断任意 locale 排序和 JavaScript 隐式转换完全等价。');
p('仓库行数检查仍报既存问题：server.js 为 3020 行，上限 3000；该文件与本轮基线一致，未修改。实验代码未加入生产 native workspace，也没有更改生产路由、构建工作流或启动开关。');
heading('切换建议');
p('保持生产逻辑不变。若用户决定继续，建议只把“数据库重型读取＋摘要读模型”作为 Rust 的下一步试点，同时保留查询索引优化；先做真实数据的只读对照和故障测试，再决定启用。日常卡片更新可以先采用增量 Node；普通数据库写入和分页缓存命中不值得单独跨语言调用。Node 工作线程能改善响应性，但本次重型读取耗时和整体峰值内存不及 Rust。');
p('正式切换前，应以真实请求分布、完整接口一致性和用户可感知的毫秒收益作为门槛。不能依据某个单卡更新的十几倍比值整体迁移，也不应把本次 SQL 索引改进算作语言改写收益。');
heading('复现');
code('node experiments/rust-read-model/build.js\nnode --test experiments/rust-read-model/correctness.test.js\nnode experiments/rust-read-model/benchmark.js --sizes 100,1277,3000,10000 --rounds 15 --out /tmp/read-model.json\nnode experiments/rust-read-model/benchmark.js --sizes 3000,10000 --rounds 15 --sqlite-index --cases dbFullLoad,dbProjectedLoad,dbWriteOne,dbWrite100 --out /tmp/read-model-indexed.json');
p('需要本机 Rust/Cargo 与项目 Node 依赖。构建缓存和原生二进制默认位于系统临时目录，模拟数据库结束时删除。MULTICC_EXPERIMENT_ADDON 可指定实验模块的绝对路径；它不是生产 MULTICC_RUST_BACKEND 开关。');
if (rawUrl && indexedUrl) {
  md.push(`[下载完整基准数据](${rawUrl}) · [下载索引补测数据](${indexedUrl})`, '');
  html.push(`<p><a href="${escape(rawUrl)}">下载完整基准数据</a> · <a href="${escape(indexedUrl)}">下载索引补测数据</a></p>`);
  p('上述预览/下载链接属于临时产物，默认保留 7 天。正式报告保存在仓库 docs 中，原始数据另保存在主仓库 data/rust-read-model-simulations/2026-10-22。');
}
fs.mkdirSync(path.dirname(markdownFile), { recursive: true });
fs.writeFileSync(markdownFile, md.join('\n'));
fs.writeFileSync(htmlFile, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rust 任务读模型模拟评测</title>'
  + '<style>body{max-width:1100px;margin:40px auto;padding:0 20px;font:16px/1.75 system-ui;color:#223047;background:#fafbfd}h1{font-size:28px}h2{margin-top:38px}h3{font-size:18px}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px;margin:12px 0}th,td{border:1px solid #d7dfea;padding:8px 12px;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{background:#edf2fa}pre{padding:18px;background:#edf2fa;overflow:auto}a{color:#125bc2}</style>' + html.join('\n') + '</html>');
console.log('报告已生成：' + markdownFile + '；预览：' + htmlFile);
