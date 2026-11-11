'use strict';
const $=id=>document.getElementById(id),view=$('view-container');let loggedIn=false,tab='overview',timer=null,fetching=false,requestGeneration=0,lastOverview=null,lastStatus=null,statusObservedAt=null,statusError=null,statusHost=null,statusPending=null,yesterdayPending=null;
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text??'—');if(cls)e.className=cls;return e;};
const fmtDate=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—',pct=value=>value==null?'—':`${(value*100).toFixed(2)}%`;
const messages={INVALID_PLACEMENT:'请输入完整视频广告点位（1–64 个字符，无首尾空格或控制字符）',RETENTION_REPORT_UNAVAILABLE:'留存报表尚未生成或暂不可用，请稍后刷新已保存报表',SAVE_REPAIR_DISABLED:'修改数据尚未启用写入',SAVE_REPAIR_INVALID_REQUEST:'请输入有效字段、正整数钻石数量和修改原因',SAVE_REPAIR_INVALID_SAVE:'存档结构或数值不受支持，为保护原数据已拒绝修改，请人工复核',SAVE_REPAIR_INVALID_LEDGER:'账目异常需人工复核，未自动修账',SAVE_REPAIR_DIAMOND_OVERFLOW:'钻石余额或原始3倍统计 int32 超限，已拒绝修改',SAVE_REPAIR_NO_SAVE:'该玩家没有云存档，不能直接创建恢复',SAVE_REPAIR_VERSION_CONFLICT:'存档已更新，请重新查询核对后再操作，不能强行覆盖',SAVE_REPAIR_REQUEST_CONFLICT:'操作编号冲突，请重新查询核对结果',SAVE_REPAIR_NO_CHANGES:'没有需要保存的修改',SAVE_REPAIR_UNAVAILABLE:'存档修改服务暂不可用',DASHBOARD_CREDENTIALS_INVALID:'账号或密码错误，请检查大小写及是否含多余空格',ORIGIN_FORBIDDEN:'来源校验失败，请通过本站 HTTPS 地址刷新后重试',INVALID_REQUEST:'输入格式有误，请检查填写内容',INVALID_UID:'UID 格式有误，请输入完整 UUID',INVALID_OPENID:'openid 格式有误，请输入完整 openid',DASHBOARD_RATE_LIMITED:'尝试过于频繁，请稍后再试',PLAYER_NOT_FOUND:'未找到该标识对应的正式玩家',DASHBOARD_UNAVAILABLE:'服务暂时不可用，请稍后重试',DASHBOARD_INVALID_INPUT:'输入格式有误，请检查 openid',DASHBOARD_LOGIN_REQUIRED:'登录已过期，请重新登录'};
// Official minigame scene list snapshot: https://developers.weixin.qq.com/minigame/dev/reference/scene-list.html
const sceneDescriptions=Object.freeze({
  "1000": "其他",
  "1001": "发现页小程序「最近使用」列表（基础库 2.2.4-2.29.0 版本包含「我的小程序」列表，2.29.1 版本起仅为「最近使用」列表）",
  "1005": "微信首页顶部搜索框的搜索结果页",
  "1006": "发现栏小程序主入口搜索框的搜索结果页",
  "1007": "单人聊天会话中的小程序消息卡片",
  "1008": "群聊会话中的小程序消息卡片",
  "1010": "收藏夹",
  "1011": "扫描二维码",
  "1012": "长按图片识别二维码",
  "1013": "扫描手机相册中选取的二维码",
  "1014": "小程序订阅消息（与 1107 相同）",
  "1017": "前往小程序体验版的入口页",
  "1018": "openWeApp JSAPI，网页打开进入小程序",
  "1019": "微信钱包（微信客户端 7.0.0 版本改为支付入口）",
  "1020": "公众号 profile 页相关小程序列表（已废弃）",
  "1022": "聊天顶部置顶小程序入口（微信客户端 6.6.1 版本起废弃）",
  "1023": "安卓系统桌面图标",
  "1024": "小程序 profile 页",
  "1025": "扫描一维码",
  "1026": "发现栏小程序主入口，「附近的小程序」列表",
  "1027": "微信首页顶部搜索框搜索结果页「使用过的小程序」列表",
  "1028": "卡包里的券和礼品卡，打开小程序",
  "1029": "小程序中的卡券详情页",
  "1030": "自动化测试下打开小程序",
  "1031": "长按图片识别一维码",
  "1032": "扫描手机相册中选取的一维码",
  "1034": "微信支付完成页",
  "1035": "公众号自定义菜单",
  "1036": "App 分享消息卡片",
  "1037": "小程序打开小程序",
  "1038": "从另一个小程序返回",
  "1039": "摇电视",
  "1042": "添加好友搜索框的搜索结果页",
  "1043": "公众号模板消息",
  "1044": "带 shareTicket 的小程序消息卡片",
  "1045": "朋友圈广告",
  "1046": "朋友圈广告详情页",
  "1047": "扫描小程序码",
  "1048": "长按图片识别小程序码",
  "1049": "扫描手机相册中选取的小程序码",
  "1052": "卡券的适用门店列表",
  "1053": "发现页进入搜一搜的搜索结果页",
  "1054": "顶部搜索框小程序快捷入口（微信客户端版本 6.7.4 起废弃）",
  "1055": "JSAPI 网页打开小程序",
  "1056": "聊天顶部音乐播放器右上角菜单",
  "1057": "钱包中的银行卡详情页",
  "1058": "公众号文章",
  "1059": "体验版小程序绑定邀请页",
  "1060": "微信支付完成页（与 1034 相同）",
  "1064": "微信首页连 Wi-Fi 状态栏",
  "1065": "URL scheme",
  "1067": "公众号文章广告",
  "1068": "附近小程序列表广告（已废弃）",
  "1069": "移动应用通过 openSDK 进入微信，打开小程序（外部所有APP跳转）",
  "1071": "钱包中的银行卡列表页",
  "1072": "二维码收款页面",
  "1073": "客服消息列表下发的小程序消息卡片",
  "1074": "公众号会话下发的小程序消息卡片",
  "1077": "摇周边",
  "1078": "微信连 Wi-Fi 成功提示页",
  "1079": "微信游戏中心",
  "1081": "客服消息下发的文字链",
  "1082": "公众号会话下发的文字链",
  "1084": "朋友圈广告原生页",
  "1088": "会话中查看系统消息，打开小程序",
  "1089": "微信聊天主界面下拉，「最近使用」栏（基础库 2.2.4-2.29.0 版本包含「我的小程序」栏，2.29.1 版本起仅为「最近使用」栏",
  "1090": "长按小程序右上角菜单唤出最近使用历史",
  "1091": "公众号文章商品卡片",
  "1092": "城市服务入口",
  "1095": "小程序广告组件",
  "1096": "聊天记录，打开小程序",
  "1097": "微信支付签约原生页，打开小程序",
  "1099": "页面内嵌插件",
  "1100": "红包封面详情页打开小程序",
  "1101": "远程调试热更新（开发者工具中，预览 -> 自动预览 -> 编译并预览）",
  "1102": "公众号 profile 页服务预览",
  "1103": "发现页小程序「我的小程序」列表（基础库 2.2.4-2.29.0 版本废弃，2.29.1 版本起生效）",
  "1104": "微信聊天主界面下拉，「我的小程序」栏（基础库 2.2.4-2.29.0 版本废弃，2.29.1 版本起生效）",
  "1106": "聊天主界面下拉，从顶部搜索结果页，打开小程序",
  "1107": "订阅消息，打开小程序",
  "1113": "安卓手机负一屏，打开小程序（三星）",
  "1114": "安卓手机侧边栏，打开小程序（三星）",
  "1119": "【企业微信】工作台内打开小程序",
  "1120": "【企业微信】个人资料页内打开小程序",
  "1121": "【企业微信】聊天加号附件框内打开小程序",
  "1124": "扫“一物一码”打开小程序",
  "1125": "长按图片识别“一物一码”",
  "1126": "扫描手机相册中选取的“一物一码”",
  "1129": "微信爬虫访问",
  "1131": "浮窗（8.0 版本起仅包含被动浮窗）",
  "1133": "硬件设备打开小程序",
  "1135": "小程序 profile 页相关小程序列表，打开小程序",
  "1144": "公众号文章 - 视频贴片",
  "1145": "发现栏 - 发现小程序",
  "1146": "地理位置信息打开出行类小程序",
  "1148": "卡包-交通卡，打开小程序",
  "1150": "扫一扫商品条码结果页打开小程序",
  "1151": "发现栏 - 我的订单",
  "1152": "订阅号视频打开小程序",
  "1153": "“识物”结果页打开小程序",
  "1154": "朋友圈内打开“单页模式”",
  "1155": "“单页模式”打开小程序",
  "1157": "服务号会话页打开小程序",
  "1158": "群工具打开小程序",
  "1160": "群待办",
  "1167": "H5 通过开放标签打开小程序",
  "1168": "移动/网站应用直接运行小程序",
  "1169": "发现栏小程序主入口，各个生活服务入口（例如快递服务、出行服务等）",
  "1171": "微信运动记录（仅安卓）",
  "1173": "聊天素材用小程序打开",
  "1175": "视频号主页商店入口",
  "1176": "视频号直播间主播打开小程序",
  "1177": "视频号直播商品",
  "1178": "在电脑打开手机上打开的小程序",
  "1179": "#话题页打开小程序",
  "1181": "网站应用打开 PC 小程序",
  "1183": "PC 微信 - 小程序面板 - 发现小程序 - 搜索",
  "1184": "视频号链接打开小程序",
  "1185": "群公告",
  "1186": "收藏 - 笔记",
  "1187": "浮窗（8.0 版本起）",
  "1189": "表情雨广告",
  "1191": "视频号活动",
  "1192": "企业微信联系人 profile 页",
  "1193": "视频号主页服务菜单打开小程序",
  "1194": "URL Link",
  "1195": "视频号主页商品 tab",
  "1196": "个人状态打开小程序",
  "1197": "视频号主播从直播间返回小游戏",
  "1198": "视频号开播界面打开小游戏",
  "1199": "小游戏内“更多游戏”入口打开小程序",
  "1200": "视频号广告打开小程序",
  "1201": "视频号广告详情页打开小程序",
  "1202": "企微客服号会话打开小程序卡片",
  "1203": "微信小程序压测工具的请求",
  "1205": "非广告进入视频号直播间打开游戏卡片",
  "1206": "视频号小游戏直播间打开小游戏",
  "1207": "企微客服号会话打开小程序文字链",
  "1208": "聊天打开商品卡片",
  "1212": "青少年模式申请页打开小程序",
  "1215": "广告预约打开小程序",
  "1216": "视频号订单中心打开小程序",
  "1218": "微信键盘预览打开小程序",
  "1219": "视频号直播间小游戏一键上车",
  "1220": "发现页设备卡片打开小程序",
  "1223": "安卓桌面 Widget 打开小程序",
  "1225": "音视频通话打开小程序",
  "1226": "聊天消息在设备打开后打开小程序",
  "1228": "视频号原生广告组件打开小程序",
  "1230": "订阅号 H5 广告进入小程序",
  "1231": "动态消息提醒入口打开小程序",
  "1232": "搜一搜竞价广告打开小程序",
  "1233": "小程序搜索页人气游戏模块打开小游戏",
  "1238": "看一看信息流广告打开小程序",
  "1239": "视频号小游戏直播间气泡浮窗打开小游戏",
  "1242": "小程序发现页门店快送模块频道页进入小程序",
  "1244": "#tag 搜索结果页打开小程序",
  "1245": "小程序发现页门店快送搜索结果页进入小程序",
  "1248": "通过小程序账号迁移进入小程序",
  "1252": "搜一搜小程序搜索页「小功能」模块进入小程序",
  "1254": "发现页「动态」卡片 打开小程序",
  "1255": "发现页「我的」卡片 打开小程序",
  "1256": "pc 端小程序面板「最近使用」列表",
  "1257": "pc 端小程序面板「我的小程序」列表",
  "1258": "pc 端小程序面板「为电脑端优化」模块",
  "1259": "pc 端小程序面板「小游戏专区」模块",
  "1260": "pc 端小程序面板「推荐在电脑端使用」列表",
  "1261": "公众号返佣商品卡片",
  "1265": "小程序图片详情页打开小程序",
  "1266": "小程序图片长按半屏入口打开小程序",
  "1267": "小程序图片会话角标打开小程序",
  "1271": "微信聊天主界面下拉，「我的常用小程序」栏",
  "1272": "发现页「游戏」服务 tab 打开小程序",
  "1273": "发现页「常用的小程序」列表",
  "1274": "移动应用通过广告openSDK 进入微信，打开小程序（特指广告联盟跳转，如腾讯优量汇）",
  "1278": "发现页「发现小程序」列表打开小程序",
  "1279": "发现页「发现小程序」合集页打开小程序",
  "1280": "下拉任务栏小程序垂搜「建议使用」打开小程序",
  "1281": "下拉任务栏小程序垂搜「发现小程序」打开小程序",
  "1282": "听一听播放器打开小程序",
  "1285": "发现页「发现小程序」短剧合集打开小程序",
  "1286": "明文 scheme 打开小程序",
  "1287": "公众号短剧贴片打开小程序",
  "1292": "发现页「发现小程序」poi 详情页打开小程序",
  "1293": "发现页短剧卡片追剧页打开小程序",
  "1295": "下拉任务栏小程序垂搜「发现小程序」广告打开小程序",
  "1296": "视频号付费短剧气泡打开小程序",
  "1297": "发现-小程序-搜索「发现小程序」打开小程序",
  "1298": "下拉任务栏小程序垂搜「发现小程序」打开的合集访问小程序",
  "1299": "下拉任务栏小程序垂搜「发现小程序」poi 详情页打开小程序",
  "1300": "发现-小程序-搜索「发现小程序」打开的合集访问小程序",
  "1301": "发现-小程序-搜索「发现小程序」poi 详情页打开小程序",
  "1302": "PC 端面板「发现小程序」",
  "1303": "发现页短剧卡片视频流打开小程序",
  "1304": "手机负一屏打开小程序（比如 oppo 手机）",
  "1305": "公众号播放结束页打开小程序",
  "1306": "公众号短剧固定选集入口打开小程序",
  "1307": "发现页附近服务境外专区打开小程序",
  "1308": "PC 端面板小游戏专区页面",
  "1309": "公众号文章打开小游戏 CPS 卡片",
  "1311": "公众号文章打开小游戏CPS卡片",
  "1313": "PC端openSDK分享卡片打开小程序",
  "1347": "「微信游戏」聊天插件打开小游戏",
  "1362": "小游戏官方组件跳转",
  "1373": "小游戏评价与推荐",
  "1374": "服务通知中「扫一扫」消息打开小程序",
  "1378": "安卓下载完成的系统通知打开小程序",
  "1379": "agent启动小程序",
  "1387": "小游戏直玩广告"
});
function formatScene(value){if(value==null)return '未上报';const id=String(value);return `${id} · ${Object.hasOwn(sceneDescriptions,id)?sceneDescriptions[id]:'官方当前文档未收录'}`;}
// Scene cells display only the raw ID; the full description stays in the tooltip.
// an absent login scene shows a dash, while the first-source column keeps its "未上报" wording.
function sceneCell(value,fallback='—'){const cell=node('td',value==null?fallback:String(value));cell.title=value==null?fallback:formatScene(value);return cell;}
async function api(path,body,isCurrent=()=>true){const r=await fetch('/h5dashboard/api/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok){if(r.status===401&&path!=='login'&&isCurrent())showLogin();throw new Error(messages[data.message]||'请求失败，请稍后重试');}return data;}
function stop(){if(timer)clearInterval(timer);timer=null;}
function showLogin(){loggedIn=false;stop();requestGeneration++;lastOverview=null;lastStatus=null;statusObservedAt=null;statusError=null;statusHost=null;statusPending=null;view.replaceChildren();$('login-screen').classList.add('active');$('dashboard-screen').classList.remove('active');$('login-form').reset();}
function start(){stop();if(loggedIn&&!document.hidden){refresh();timer=setInterval(refresh,30000);}}
function showDashboard(){loggedIn=true;$('login-error').textContent='';$('password').value='';$('login-screen').classList.remove('active');$('dashboard-screen').classList.add('active');switchView('overview');start();}
function switchView(next){tab=next;requestGeneration++;$('page-title').textContent={overview:'实时概览',player:'玩家查询',saveRepair:'修改数据',loginLogs:'登录日志',videoLogs:'视频日志',videoRanking:'视频排行',yesterdayAnalysis:'昨日用户分析',retentionReport:'留存分析'}[tab];document.querySelectorAll('.nav-btn').forEach(e=>e.classList.toggle('active',e.dataset.view===tab));view.replaceChildren();if(tab==='overview'){if(lastOverview){renderOverview(lastOverview);scheduleStatusRefresh();}else{view.append(node('p','正在加载正式服数据…','loading'));statusHost=node('div',undefined,'production-status-host');view.append(statusHost);renderProductionStatus(lastStatus);}}else if(tab==='saveRepair')renderSaveRepairForm();else if(tab==='loginLogs')renderLoginLogsForm();else if(tab==='videoLogs')renderVideoLogsForm();else if(tab==='videoRanking')renderVideoRankingForm();else if(tab==='retentionReport')renderRetentionReportForm();else if(tab==='yesterdayAnalysis')renderYesterdayAnalysisForm();else renderPlayerForm();}
function scheduleStatusRefresh(){Promise.resolve().then(()=>{if(loggedIn&&tab==='overview'&&!document.hidden)fetchStatus();});}
async function loadOverview(generation){try{const result=await api('overview');if(!loggedIn||generation!==requestGeneration)return;lastOverview=result;if(tab==='overview')renderOverview(result);}catch(e){if(loggedIn&&generation===requestGeneration&&tab==='overview'){statusHost=null;view.replaceChildren(node('p',e.message,'error active'));}}}
async function fetchStatus(){
 if(!loggedIn||tab!=='overview'||document.hidden||statusPending)return;
 const generation=requestGeneration;
 const task=(async()=>{
  try{const data=await api('production-status');if(!loggedIn||generation!==requestGeneration||tab!=='overview')return;
   if(!isStatusPayload(data)){lastStatus=null;statusObservedAt=null;statusError='返回数据格式异常';renderProductionStatus(null);return;}
   lastStatus=data;statusObservedAt=new Date().toISOString();statusError=null;renderProductionStatus(data);
  }catch(e){if(!loggedIn||generation!==requestGeneration||tab!=='overview')return;lastStatus=null;statusObservedAt=null;statusError=e.message||'读取失败';renderProductionStatus(null);}
 })();
 statusPending=task;
 try{await task;}finally{if(statusPending===task)statusPending=null;}
}
async function refresh(){if(!loggedIn||document.hidden||tab==='retentionReport')return;if(tab==='yesterdayAnalysis'){await loadYesterdayAnalysis();return;}const generation=requestGeneration,jobs=[];if(!fetching){fetching=true;jobs.push(loadOverview(generation).finally(()=>{fetching=false;}));}if(tab==='overview'&&!statusPending)jobs.push(fetchStatus());await Promise.allSettled(jobs);}
const STATUS_NOTE='每 30 秒刷新，状态缓存最多 10 秒；探测只代表检查时点，不等于所有业务正常；开关显示配置值；微信受理不代表用户已收件';
const STATUS_READONLY_NOTE='看板只读连接（共享实例，探测只代表该连接，不代表全部游戏链路）';
const statusWord=state=>state==='ok'?'正常':state==='error'?'异常':'未知';
const statusTone=word=>word==='正常'?'ok':word==='异常'?'bad':'unknown';
const numText=value=>typeof value==='number'&&Number.isFinite(value)?String(value):'—';
const rawText=value=>value==null?'—':String(value);
const serviceText=value=>value===true?'运行中':value===false?'未运行':'未知';
const probeText=value=>value===true?'通过':value===false?'失败':'未执行';
const receiptText=state=>state==='sent'?'微信已受理':state==='failed'?'发送失败':state==='sending'?'发送中':'结果未知';
function statusItem(label,value,detail,tone){const item=node('div',undefined,'status-item');item.append(node('h3',label,'status-item-label'),node('p',value,'status-item-value'+(tone?' status-value-'+tone:'')),node('p',detail,'status-item-detail'));return item;}
function isStatusPayload(data){return !!data&&typeof data==='object'&&!Array.isArray(data)&&!!data.api&&typeof data.api==='object';}
function renderProductionStatus(data,target){
 const host=target||statusHost;if(!host)return;host.replaceChildren();
 const section=node('section',undefined,'production-status');section.id='production-status-panel';
 if(!isStatusPayload(data)){const head=node('div',undefined,'status-head');head.append(node('h2','正式服运行状态','status-title'),node('span','未知','status-badge status-badge-unknown'));section.append(head,node('p',statusError?`读取失败：${statusError} · 界面不展示上一次的健康结果`:'正在读取正式服运行状态…',statusError?'status-message error active':'status-message loading'),node('p',STATUS_NOTE,'status-note'));host.append(section);return;}
 const apiBlock=data.api||{},db=data.database||{},redisBlock=data.redis||{},subs=data.subscriptions||{},schedule=subs.schedule||{},receipts=subs.receipts||{},boards=data.leaderboards||{};
 const apiWord=apiBlock.state==='ok'&&apiBlock.serviceActive===true&&apiBlock.probeOk===true?'正常':(apiBlock.state==='error'||apiBlock.serviceActive===false||apiBlock.probeOk===false?'异常':'未知'),dbWord=statusWord(db.state),redisWord=statusWord(redisBlock.state);
 const overall=apiWord==='异常'||dbWord==='异常'||redisWord==='异常'?'异常':apiWord==='未知'||dbWord==='未知'||redisWord==='未知'?'未知':'正常';
 const head=node('div',undefined,'status-head');head.append(node('h2','正式服运行状态','status-title'),node('span',overall,'status-badge status-badge-'+statusTone(overall)));section.append(head);
 section.append(node('p',`环境 ${data.environment==='production'?'正式服 production':rawText(data.environment)} · 检查时间 ${fmtDate(data.checkedAt)} · 获取于 ${fmtDate(statusObservedAt)} · 服务端刷新间隔 ${numText(data.refreshSeconds)} 秒`,'status-meta'));
 const grid=node('div',undefined,'status-grid');
 grid.append(statusItem('接口服务',apiWord,`systemd 服务：${serviceText(apiBlock.serviceActive)} · 只读探测：${probeText(apiBlock.probeOk)} · 探测只代表检查时点，不等于所有业务正常`,statusTone(apiWord)));
 grid.append(statusItem('数据库',dbWord,`${STATUS_READONLY_NOTE} · 探测只代表检查时点，不等于全部读写链路正常`,statusTone(dbWord)));
 grid.append(statusItem('Redis',redisWord,`${STATUS_READONLY_NOTE} · 探测只代表检查时点，不等于全部缓存链路正常`,statusTone(redisWord)));
 const jump=subs.jumpState==='formal'?'正式版':subs.jumpState==='trial'?'体验版':'未知';
 grid.append(statusItem('订阅提醒',`${subs.enabled===true?'已开启':subs.enabled===false?'未开启':'未知'} · 跳转${jump}`,`开关显示配置值（${subs.enabled===false?'当前为关闭，不会发送提醒':'不代表消息已实际触达用户'}） · 跳转版本：${jump}`,''));
 const nextRun=schedule.nextRunAt?`下次 ${fmtDate(schedule.nextRunAt)}`:'下次运行时间未知';
 const timerKnown=typeof schedule.enabled==='boolean'&&typeof schedule.active==='boolean';
 const triggered=schedule.lastTriggerAt?`上次定时触发 ${fmtDate(schedule.lastTriggerAt)}`:timerKnown?'尚未定时触发（窗口外手动启动不计入定时批次）':'触发情况未知（定时任务配置读取失败）';
 const worker=schedule.workerResult==null?'脚本执行结果：无记录':`脚本执行结果：${rawText(schedule.workerResult)}`;
 const exit=schedule.exitCode==null?'':` · 退出码 ${numText(schedule.exitCode)}`;
 const workerNote=schedule.workerResult==='success'?' · 执行成功仅代表任务跑完，不代表消息已发送或用户已收件':'';
 grid.append(statusItem('定时发送',`${schedule.enabled===true?'已启用':schedule.enabled===false?'未启用':'未知'} · ${serviceText(schedule.active)}`,`${nextRun} · ${triggered} · ${worker}${exit}${workerNote}`,''));
 const available=receipts.available===true,today=receipts.today||null,last=receipts.last||null;
 let receiptValue='未知',receiptDetail='';
 if(!available){receiptDetail='回执数据不可用：计数显示“—”而不是 0';}
 else{receiptValue=`今日尝试 ${numText(today&&today.total)}`;receiptDetail=`受理 ${numText(today&&today.sent)} · 失败 ${numText(today&&today.failed)} · 未知 ${numText(today&&today.unknown)} · 发送中 ${numText(today&&today.sending)} · 按开始时间归入北京时间自然日（应用/模板消息）`;}
 const lastInfo=!available?'最近一次：未知（回执数据不可用）':last?`最近一次：${receiptText(last.state)}（开始 ${fmtDate(last.startedAt)}${last.finishedAt?` · 完成 ${fmtDate(last.finishedAt)}`:''}${last.scheduledDate?` · 计划 ${last.scheduledDate}`:''}${last.upstreamCode==null?'':` · 返回码 ${numText(last.upstreamCode)}`}）`:'最近一次：尚无发送记录';
 receiptDetail+=` · ${lastInfo}`;
 if(available&&today&&today.total===0)receiptDetail+=last?' · 今日尚无发送尝试':' · 今日尚无受理记录，首个真实回执待产生';
 grid.append(statusItem('发送回执',receiptValue,receiptDetail,''));
 grid.append(statusItem('排行榜门槛',`关卡榜 ${rawText(boards.stageMinimum)} · Boss 榜 ${rawText(boards.bossMinimum)}`,'判档门槛来自服务端实际数据，不写死在页面里',''));
 section.append(grid,node('p',STATUS_NOTE,'status-note'));
 host.append(section);
}
function metric(title,value,detail,comparison){const box=node('section',undefined,'metric-card');let valueClass='metric-value';if(comparison&&Number.isFinite(value)&&Number.isFinite(comparison.value)){if(value>comparison.value)valueClass+=' metric-value-better';else if(value<comparison.value)valueClass+=' metric-value-worse';}box.append(node('h3',title),node('div',value,valueClass));if(detail)box.append(node('div',detail,'metric-detail'));if(comparison){const label=node('small',`昨日同期：${numText(comparison.value)}`,'metric-comparison');label.title=`北京时间 ${fmtDate(comparison.cutoffAt)} 截至同一时刻；缺少历史证据显示 —`;box.append(label);}return box;}
function renderOverview(data){view.replaceChildren();const m=data.metrics,y=data.yesterdaySameTime,compare=key=>({value:y?.[key],cutoffAt:y?.cutoffAt}),grid=node('div',undefined,'metrics-grid');grid.append(metric('今日活跃用户',m.dau??'—','今日登录成功的独立用户',compare('dau')),metric('今日新注册',m.newUsers,undefined,compare('newUsers')),metric('今日邀请新注册',m.invitedNewUsers??'—',`占今日新注册 ${pct(m.newUsers>0&&m.invitedNewUsers!=null?m.invitedNewUsers/m.newUsers:null)}`,compare('invitedNewUsers')),metric('实时次日留存',pct(m.d1.rate),`昨日新增 ${m.d1.cohortSize} · 今日回访 ${m.d1.returned??'—'}`),metric('累计用户',m.totalUsers),metric('今日激励视频次数',m.todayRewardedVideos??'—',`人均 ${m.dau>0&&m.todayRewardedVideos!=null?(m.todayRewardedVideos/m.dau).toFixed(2):'—'} 次（按今日活跃用户） · 北京时间当日 · 客户端上报完成 · 按事件去重`,compare('todayRewardedVideos')));view.append(grid,statusHost=node('div',undefined,'production-status-host'),node('p',`北京时间 ${data.today} · 每 30 秒刷新 · 统计缓存最多 30 秒 · 更新于 ${fmtDate(data.generatedAt)}`,'metric-detail'),node('p','昨日同期按北京时间昨日 00:00 至与“更新于”相同的时分秒比较，不是昨日全天；邀请注册须在该截止时刻前完成绑定。缺少历史活跃证据时显示 —，不表示 0。','metric-detail'),node('p',`逐日活跃记录自 ${data.coverageStart} 开始；上线当天按最后登录时间补录当日已登录用户，不反推此前每日活跃。历史新注册人数可查询；缺少历史活跃证据时显示“—”，不表示 0。`,'coverage-notice'),node('p','邀请注册是新注册中的一部分：按注册日期归属，成功绑定邀请关系即计入，与是否领奖无关；绑定延迟上报后会更新对应日期人数。趋势中括号内邀请注册占比 = 当日邀请注册人数 ÷ 当日新注册人数，保留两位小数；分母为 0 或数据缺失时显示“—”。','metric-detail'),node('h2','近 14 天趋势'),node('p','周六、周日整行以绿色标记，按表中北京时间日期判断。','metric-detail'));
 const table=node('table',undefined,'history-table'),head=node('thead'),header=node('tr');for(const title of ['北京时间日期','新注册','其中邀请注册','登录活跃','次日留存','次日回访 / 当日新增','激励视频次数','注册用户视频数'])header.append(node('th',title));head.append(header);const body=node('tbody');for(const d of [...data.history].sort((a,b)=>b.date.localeCompare(a.date))){const weekday=new Date(d.date+'T00:00:00Z').getUTCDay(),weekend=weekday===0||weekday===6,row=node('tr',undefined,weekend?'history-weekend':'');for(const val of [d.date+(weekend?(weekday===6?'（周六）':'（周日）'):'')+(d.date===data.today?'（截至现在）':''),d.newUsers,`${d.invitedNewUsers??'—'}（${pct(d.newUsers>0&&d.invitedNewUsers!=null?d.invitedNewUsers/d.newUsers:null)}）`,d.dau??'—',d.date===data.today?'待次日统计':pct(d.d1Rate)+(d.retentionDate===data.today&&d.d1Rate!=null?'（实时）':''),d.date===data.today?'待次日统计':`${d.returned??'—'} / ${d.cohortSize}`,`${d.rewardedVideos??'—'}（人均 ${d.dau>0&&d.rewardedVideos!=null?(d.rewardedVideos/d.dau).toFixed(2):'—'} 次）`,`${d.registeredUserVideos??'—'}（人均 ${d.newUsers>0&&d.registeredUserVideos!=null?(d.registeredUserVideos/d.newUsers).toFixed(2):'—'} 次）`])row.append(node('td',val));body.append(row);}table.append(head,body);const wrap=node('div',undefined,'history-table-container');wrap.append(table);view.append(wrap,node('p','注册用户视频数 = 当天注册用户在当天上报完成的激励视频次数，不含其以后日期的观看；人均 = 注册用户视频数 ÷ 当日新注册人数（包含未观看视频的新用户），保留两位小数；注册人数为 0 或数据缺失时显示“—”。','metric-detail'),node('p','激励视频次数按北京时间当日客户端上报完成事件统计，按事件去重，与今日视频卡片同口径；人均次数 = 当日激励视频次数 ÷ 当日登录活跃人数（包含未观看视频的活跃用户），保留两位小数；活跃人数为 0 或数据缺失时人均显示“—”。无上报记录显示 0，不代表玩家实际未观看，未接入前的历史不补造。','metric-detail'),node('p','次日留存按注册日期归属 = 该日新用户在次日登录的人数 ÷ 该日新注册人数。今天的新用户待次日统计；昨日这一行随今天回访实时更新，今天结束后为整日值；分母为 0 或次日活跃数据未覆盖时显示“—”。顶部卡片仍为昨日新用户的实时次留。','metric-detail'));renderProductionStatus(lastStatus);}
const RETENTION_PERIODS=Object.freeze([1,3,5,7,14,20,30]);
const retentionCount=value=>Number.isSafeInteger(value)&&value>=0;
const retentionCountText=value=>retentionCount(value)?String(value):'—';
const retentionDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const retentionValue=item=>!!item&&retentionCount(item.cohortSize)&&item.cohortSize>0&&retentionCount(item.returned)&&item.returned<=item.cohortSize&&typeof item.rate==='number'&&Number.isFinite(item.rate)&&item.rate>=0&&item.rate<=1;
function isRetentionReport(data){return !!data&&data.schemaVersion===1&&data.environment==='production'&&data.timezone==='Asia/Shanghai'&&retentionDay(data.asOfDate)&&retentionDay(data.coverageStart)&&typeof data.generatedAt==='string'&&Number.isFinite(Date.parse(data.generatedAt))&&(data.trackingStartedAt==null||typeof data.trackingStartedAt==='string'&&Number.isFinite(Date.parse(data.trackingStartedAt)))&&Number.isInteger(data.historyDays)&&data.historyDays>=1&&data.historyDays<=366&&Array.isArray(data.periods)&&data.periods.length===RETENTION_PERIODS.length&&RETENTION_PERIODS.every((day,i)=>data.periods[i]===day)&&Array.isArray(data.summary)&&Array.isArray(data.cohorts)&&data.cohorts.length<=data.historyDays&&data.cohorts.every(cohort=>cohort&&retentionDay(cohort.date)&&Array.isArray(cohort.cells));}
function renderRetentionReportForm(){
 const generation=requestGeneration,button=node('button','刷新已保存报表'),target=node('div');
 button.type='button';button.id='retention-report-refresh';target.id='retention-report-results';target.setAttribute('aria-live','polite');
 let sequence=0;const active=()=>loggedIn&&tab==='retentionReport'&&generation===requestGeneration;
 const load=async()=>{if(!active())return;const current=++sequence;target.replaceChildren(node('p','正在读取已保存留存报表…','loading'));try{const data=await api('retention-report',undefined,()=>active()&&current===sequence);if(active()&&current===sequence)renderRetentionReport(data,target);}catch(e){if(active()&&current===sequence)target.replaceChildren(node('p',messages.RETENTION_REPORT_UNAVAILABLE,'error active'));}};
 button.addEventListener('click',load);view.append(button,node('p','只读已保存快照；刷新仅重新读取报表，不触发实时重算。北京时间计划更新 00:10。','metric-detail'),target);load();
}
function renderRetentionReport(data,target){
 if(!isRetentionReport(data)){target.replaceChildren(node('p','留存报表数据格式异常，暂不可用，请稍后刷新已保存报表。','error active'));return;}
 target.replaceChildren(node('p',`数据截至 ${data.asOfDate}（北京时间完整自然日） · 实际生成时间（北京时间） ${fmtDate(data.generatedAt)} · 历史窗口 ${data.historyDays} 天`,'metric-detail'),node('p',`覆盖起点 ${data.coverageStart} · 登录采集开始（北京时间） ${fmtDate(data.trackingStartedAt)}`,'metric-detail'));
 const now=new Date(),today=now.toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}),previous=new Date(today+'T00:00:00Z');previous.setUTCDate(previous.getUTCDate()-1);const yesterday=previous.toISOString().slice(0,10),dayBeforeYesterday=new Date(previous.getTime()-86400000).toISOString().slice(0,10),beijingMinute=(now.getUTCHours()+8)%24*60+now.getUTCMinutes(),waitingForSchedule=data.asOfDate===dayBeforeYesterday&&beijingMinute<10;
 if(waitingForSchedule)target.append(node('p','待北京时间 00:10 计划更新；当前仍展示上一份完整报表。','metric-detail'));
 if(data.asOfDate<yesterday&&!waitingForSchedule){const warning=node('p',`报表已过期：数据仅截至 ${data.asOfDate}，北京时间昨日为 ${yesterday}；报表未更新，请核查快照生成情况，以下保留原快照，不表示当前数据。`,'retention-expired');warning.setAttribute('role','alert');target.append(warning);}
 const summary=node('div',undefined,'metrics-grid retention-summary');
 for(const day of RETENTION_PERIODS){const item=data.summary.find(s=>s?.day===day),card=metric(`D${day}`,pct(retentionValue(item)?item.rate:null),`回访 / 样本 ${retentionCountText(item?.returned)} / ${retentionCountText(item?.cohortSize)} · ${retentionCountText(item?.cohortDays)} 个注册批次`);card.dataset.day=String(day);summary.append(card);}
 target.append(node('h2','留存汇总（已保存快照）'),node('p','各 Dn 仅按已成熟、已覆盖且有新增的注册批次人数加权；分母不混合未成熟批次，不是每日百分比的算术平均。','metric-detail'),summary);
 const wrap=node('div',undefined,'history-table-container'),table=node('table',undefined,'history-table retention-report-table'),head=node('thead'),header=node('tr'),body=node('tbody');
 for(const title of ['注册日期（北京时间）','新增',...RETENTION_PERIODS.map(day=>`D${day}`)])header.append(node('th',title));head.append(header);
 const weekdays=['周日','周一','周二','周三','周四','周五','周六'];
 for(const cohort of [...data.cohorts].sort((a,b)=>b.date.localeCompare(a.date))){const weekday=new Date(cohort.date+'T00:00:00Z').getUTCDay(),row=node('tr',undefined,weekday===0||weekday===6?'history-weekend':'');row.append(node('td',`${cohort.date}（${weekdays[weekday]}）`),node('td',retentionCountText(cohort.newUsers)));
  for(const day of RETENTION_PERIODS){const cell=cohort.cells.find(c=>c?.day===day),td=node('td');if(cell?.status==='complete'&&retentionValue(cell))td.append(node('strong',pct(cell.rate)),node('small',`${cell.returned} / ${cell.cohortSize}`,'retention-sample'));else td.textContent=cell?.status==='pending'?'待统计':cell?.status==='uncovered'?'无覆盖':cell?.status==='empty'?'—（无新增）':'—（未知）';if(cell)td.title=`D${day} · 观察日期 ${typeof cell.observationDate==='string'?cell.observationDate:'—'}`;row.append(td);}body.append(row);
 }
 if(!data.cohorts.length){const row=node('tr'),cell=node('td','暂无注册批次，尚无可展示样本。');cell.colSpan=9;row.append(cell);body.append(row);}
 table.append(head,body);wrap.append(table);target.append(wrap,node('p','Dn（如 D7）指注册后第 n 个自然日当天登录，而非 n 天内累计；按北京时间自然日对成功登录用户每日去重。长周期样本不足不代表 0。','coverage-notice'));
}
function renderYesterdayAnalysisForm(){
 const refreshButton=node('button','刷新'),target=node('div');refreshButton.type='button';target.id='yesterday-analysis-results';refreshButton.addEventListener('click',()=>loadYesterdayAnalysis());view.append(refreshButton,target);loadYesterdayAnalysis();
}
async function loadYesterdayAnalysis(){
 if(!loggedIn||tab!=='yesterdayAnalysis'||document.hidden)return;
 const generation=requestGeneration;if(yesterdayPending?.generation===generation)return yesterdayPending.task;
 const host=Array.from(view.children).find(e=>e.id==='yesterday-analysis-results'),pending={generation,task:null};if(!host)return;yesterdayPending=pending;
 pending.task=(async()=>{try{const data=await api('yesterday-analysis',{});if(loggedIn&&tab==='yesterdayAnalysis'&&generation===requestGeneration)renderYesterdayAnalysis(data,host);}catch(e){if(loggedIn&&tab==='yesterdayAnalysis'&&generation===requestGeneration)host.replaceChildren(node('p',e.message,'error active'));}finally{if(yesterdayPending===pending)yesterdayPending=null;}})();
 return pending.task;
}
function renderYesterdayAnalysis(data,target){
 target.replaceChildren(node('p',`北京时间 ${data.cohortDate} 新注册队列 · 今日 ${data.today} 回访（实时） · 每 30 秒刷新 · 更新于 ${fmtDate(data.generatedAt)}`,'metric-detail'),node('p','按用户首次上报的注册来源 scene 分组，并非本次登录场景；未上报单独列出。视频仅统计该队列在昨日已入库的完成事件，按事件去重，不是观看人数，不代表广告平台核实的有效播放量。今日回访按成功登录用户去重。各图占比分母为该图总人数或总次数。','coverage-notice'));
 const colors=['#2563eb','#d97706','#059669','#db2777','#7c3aed','#0891b2','#dc2626','#4f46e5','#65a30d','#c026d3','#0d9488','#9333ea'];
 const groups=[data.registrations,data.rewardedVideos,data.returnedUsers],keys=[...new Set(groups.flatMap(g=>(g.items??[]).map(x=>JSON.stringify(x.scene))))].sort();
 const color=scene=>colors[keys.indexOf(JSON.stringify(scene))%colors.length],grid=node('div',undefined,'scene-charts-grid');
 for(const [index,title,unit]of [[0,'昨日注册 scene','人'],[1,'昨日注册用户昨日激励视频次数','次'],[2,'昨日注册今日实时登录用户','人']]){
  const group=groups[index],section=node('section',undefined,'scene-chart');section.append(node('h2',title),node('p',`合计 ${group.total??'—'} ${unit}`,'scene-chart-total'));
  if(group.total==null){section.append(node('p','今日登录数据未覆盖，无法统计；不表示 0。','coverage-notice'));}
  else if(group.total===0){section.append(node('p',index===1?'昨日暂无该队列已上报的视频完成记录':index===2?'该队列今日暂无成功登录用户':'昨日暂无已完成首次登录的新注册用户','metric-detail'));}
  else{
   const svgNode=(tag,attrs)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))e.setAttribute(k,v);return e;};
   const svg=svgNode('svg',{viewBox:'0 0 240 240',width:240,height:240,role:'img','aria-label':`${title}，合计 ${group.total} ${unit}；各 scene 数量和占比见下方图例`});let angle=-Math.PI/2;
   for(const item of group.items){if(item.value<=0)continue;const next=angle+item.value/group.total*Math.PI*2;let shape;
    if(item.value===group.total)shape=svgNode('circle',{cx:120,cy:120,r:108,fill:color(item.scene)});
    else shape=svgNode('path',{d:`M 120 120 L ${120+108*Math.cos(angle)} ${120+108*Math.sin(angle)} A 108 108 0 ${next-angle>Math.PI?1:0} 1 ${120+108*Math.cos(next)} ${120+108*Math.sin(next)} Z`,fill:color(item.scene),stroke:'var(--color-bg, #fff)','stroke-width':1});
    const tip=svgNode('title',{});tip.textContent=`${formatScene(item.scene)}：${item.value} ${unit}（${pct(item.value/group.total)}）`;shape.append(tip);svg.append(shape);angle=next;
   }section.append(svg);
   const legend=node('ul',undefined,'scene-legend');for(const item of group.items){const row=node('li'),swatch=svgNode('svg',{width:12,height:12,viewBox:'0 0 12 12','aria-hidden':'true'});swatch.append(svgNode('rect',{width:12,height:12,rx:2,fill:color(item.scene)}));row.append(swatch,node('span',formatScene(item.scene),'scene-legend-label'),node('strong',`${item.value} ${unit}（${pct(item.value/group.total)}）`));legend.append(row);}section.append(legend);
  }grid.append(section);
 }target.append(grid);
}
function renderSaveRepairForm(){
 const generation=requestGeneration,form=node('form',undefined,'save-repair-form'),openid=node('input'),search=node('button','查找玩家'),status=node('p'),details=node('section'),editor=node('section',undefined,'save-repair-editor'),ads=node('input'),dia=node('input'),reason=node('input'),previewButton=node('button','预览修改'),applyButton=node('button','确认保存'),previewHost=node('div');
 form.id='save-repair-form';openid.id='save-repair-openid';openid.type='text';openid.required=true;openid.maxLength=128;openid.autocomplete='off';search.type='submit';status.id='save-repair-status';
 ads.id='save-repair-ads';ads.type='checkbox';dia.id='save-repair-dia';dia.type='number';dia.min='1';dia.step='1';dia.value='';reason.id='save-repair-reason';reason.type='text';reason.maxLength=200;reason.required=true;reason.value='';reason.placeholder='玩家钻石补偿';previewButton.id='save-repair-preview';applyButton.id='save-repair-apply';previewButton.type=applyButton.type='button';
 const label=(text,input)=>{const e=node('label',text);e.htmlFor=input.id;const group=node('div',undefined,'form-group');group.append(e,input);return group;};
 form.append(label('玩家 openid',openid),search);editor.append(label('全部免广告（Is_Remove_AD_All）',ads),label('补偿钻石数量（余额增加 N，累计获取统计增加 3N）',dia),label('修改原因',reason),previewButton,previewHost,applyButton);
 view.append(node('p','请先让玩家退出游戏。修改完成后重新登录并读取云存档，避免本地旧进度覆盖恢复结果。只修改所选字段，其余存档原文保留；_useDia 不变。_getDia / _useDia 为原始3倍统计，非实际钻石。','coverage-notice'),form,status,details,editor);
 let loaded=null,prepared=null,busy=false,epoch=0;
 const active=()=>loggedIn&&tab==='saveRepair'&&generation===requestGeneration;
 const update=()=>{search.disabled=openid.disabled=busy;const editable=!!loaded?.save?.exists;editor.hidden=!editable;ads.disabled=dia.disabled=reason.disabled=busy||!editable;previewButton.disabled=busy||!editable;applyButton.disabled=busy||!prepared||loaded?.writable!==true;};
 const invalidate=()=>{epoch++;prepared=null;previewHost.replaceChildren();update();};
 const notice=(text,error=false)=>{status.textContent=text;status.className=error?'error active':'metric-detail';};
 const changeText=(before,after,key)=>{if(key==='Is_Remove_AD_All')return '—';const delta=after[key]-before[key];return delta>0?`+${delta}`:String(delta);};
 const rows=(before,after=null)=>{const table=node('table',undefined,'history-table save-repair-table'),head=node('tr');head.append(node('th','字段'),node('th',after?'原始值':'当前值'));if(after)head.append(node('th','修改值'),node('th','增量'));table.append(head);for(const key of ['Is_Remove_AD_All','Dia','_getDia','_useDia']){const row=node('tr');row.append(node('td',key),node('td',String(before[key])));if(after)row.append(node('td',String(after[key])),node('td',changeText(before,after,key)));table.append(row);}return table;};
 openid.addEventListener('input',()=>{loaded=null;invalidate();details.replaceChildren();notice('openid 已变更，请重新查找玩家');});
 for(const control of [ads,dia,reason]){control.addEventListener('input',invalidate);control.addEventListener('change',invalidate);}
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!active())return;const value=openid.value;if(!/^[A-Za-z0-9_-]{1,128}$/.test(value)){notice(messages.INVALID_OPENID,true);return;}
  loaded=null;invalidate();const current=epoch;busy=true;update();details.replaceChildren();notice('正在查找玩家存档…');
  try{const found=await api('save-repair/lookup',{openid:value});if(!active()||current!==epoch||openid.value!==value)return;loaded=found;details.append(node('p',`UID：${found.user.id} · openid：${found.user.openid} · 昵称：${found.user.nickname||'—'}`),node('p',`存档版本：${found.save.version} · 更新时间（北京时间）：${fmtDate(found.save.updatedAt)}`));
   if(!found.save.exists){notice(messages.SAVE_REPAIR_NO_SAVE,true);return;}
   details.append(rows(found.fields));ads.checked=found.fields.Is_Remove_AD_All;dia.value='';reason.value='';notice(found.writable?'已加载，请填写恢复内容并预览':'未启用写入，可查询并预览，不能保存');
  }catch(error){if(active()&&current===epoch)notice(error.message,true);}finally{busy=false;if(active())update();}
 });
 previewButton.addEventListener('click',async()=>{
  if(busy||!loaded?.save.exists||!active())return;
  const raw=dia.value;if(dia.validity?.badInput||(raw!==''&&(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>2147483647))){invalidate();notice('补偿钻石必须是正整数（1–2147483647）；不补偿时请留空',true);return;}
  if(!reason.value.trim()||Array.from(reason.value).length>200||/[\u0000-\u001f\u007f]/.test(reason.value)){invalidate();notice('请填写有效修改原因（1–200 字）',true);return;}
  const changes={};if(ads.checked!==loaded.fields.Is_Remove_AD_All)changes.removeAds=ads.checked;if(Number(raw)>0)changes.addDia=Number(raw);
  if(!Object.keys(changes).length){invalidate();notice(messages.SAVE_REPAIR_NO_CHANGES,true);return;}
  invalidate();const current=epoch,input={openid:loaded.user.openid,version:loaded.save.version,fingerprint:loaded.fingerprint,changes},savedReason=reason.value;busy=true;update();notice('正在预览，尚未修改玩家数据…');
  try{const preview=await api('save-repair/preview',input);if(!active()||current!==epoch)return;prepared={input,reason:savedReason,preview};previewHost.replaceChildren(node('h3','修改预览（尚未保存）'),rows(preview.before,preview.after));notice(loaded.writable?'请核对玩家和修改前后数值，再确认保存':'未启用写入：当前仅预览');}
  catch(error){if(active()&&current===epoch){loaded=null;notice(error.message+'；请重新查找玩家',true);}}finally{busy=false;if(active())update();}
 });
 applyButton.addEventListener('click',async()=>{
  if(busy||!prepared||loaded?.writable!==true||!active())return;const plan=prepared;
  if(!reason.value.trim()||reason.value!==plan.reason){invalidate();notice('请填写有效修改原因（1–200 字）并重新预览',true);return;}
  const lines=['确认修改该玩家云存档？',`openid：${plan.input.openid}`,`UID：${loaded.user.id}`,...['Is_Remove_AD_All','Dia','_getDia','_useDia'].map(k=>`${k}：${plan.preview.before[k]} → ${plan.preview.after[k]}（增量：${changeText(plan.preview.before,plan.preview.after,k)}）`),`原因：${plan.reason}`,'_getDia / _useDia 为原始3倍统计，非实际钻石。','请确认玩家已退出游戏。'];if(!confirm(lines.join('\n')))return;
  busy=true;update();const current=epoch;
  try{const result=await api('save-repair/apply',{...plan.input,requestId:crypto.randomUUID(),reason:plan.reason});if(!active()||current!==epoch)return;loaded=null;prepared=null;details.replaceChildren(node('p',`UID：${result.user.id} · openid：${result.user.openid} · 保存后版本：${result.save.version}`),rows(result.fields));previewHost.replaceChildren();notice(`保存成功，存档版本 ${result.save.version}。请让玩家重新登录读取云存档；再次修改前请重新查询。`);}
  catch(error){if(active()&&current===epoch){loaded=null;prepared=null;previewHost.replaceChildren();notice(error.message+'；结果可能已保存，请重新查询核对，勿直接重复补发。',true);}}
  finally{busy=false;if(active())update();}
 });
 update();
}
function renderVideoRankingForm(){
 const controls=node('div',undefined,'login-log-controls'),label=node('label','查询日期（北京时间）'),dateInput=node('input'),result=node('div'),refreshButton=node('button','刷新'),todayButton=node('button','今天');let selectedDate=null;
 dateInput.type='date';dateInput.id='video-ranking-date';dateInput.required=true;label.htmlFor=dateInput.id;result.id='video-ranking-results';refreshButton.type=todayButton.type='button';
 const query=()=>loadVideoRanking(result,dateInput,selectedDate);dateInput.addEventListener('change',()=>{selectedDate=dateInput.value;return query();});refreshButton.addEventListener('click',query);todayButton.addEventListener('click',()=>{selectedDate=null;dateInput.value='';return query();});controls.append(label,dateInput,refreshButton,todayButton);
 view.append(node('p','按北京时间所选日期激励视频上报次数倒序展示前 20 名；次数相同按玩家 UID 倒序。历史总次数为该玩家全部已入库记录，含所选日期以外的记录。统计按事件去重，不读取存档计数，不代表广告平台核实的有效播放量。','coverage-notice'),controls,result);
 query();
}
async function loadVideoRanking(target,dateInput,date=null){const generation=++requestGeneration;if(date===''){target.replaceChildren(node('p','请选择查询日期','error active'));return;}target.replaceChildren(node('p','正在加载视频排行…','loading'));try{const data=await api('video-ranking',date===null?{}:{date});if(loggedIn&&tab==='videoRanking'&&generation===requestGeneration){dateInput.value=data.date;renderVideoRanking(data,target);}}catch(err){if(loggedIn&&tab==='videoRanking'&&generation===requestGeneration)target.replaceChildren(node('p',err.message,'error active'));}}
function renderVideoRanking(data,target){
 target.replaceChildren(node('p',`北京时间 ${data.date} · 当日上报次数前 20 名 · 展示 ${data.items.length} 人 · 更新于 ${fmtDate(data.generatedAt)}`,'metric-detail'));
 const wrap=node('div',undefined,'history-table-container'),table=node('table',undefined,'history-table video-ranking-table'),head=node('thead'),header=node('tr'),body=node('tbody');
 for(const title of ['排名','昵称','openid','当日激励视频次数','历史总次数'])header.append(node('th',title));head.append(header);
 for(const item of data.items){const row=node('tr');row.append(node('td',item.rank),node('td',item.nickname||'—'),node('td',item.openid),node('td',item.dailyCount),node('td',item.totalCount));body.append(row);}
 if(!data.items.length){const row=node('tr'),cell=node('td','所选日期暂无已上报的视频完成记录');cell.colSpan=5;row.append(cell);body.append(row);}
 table.append(head,body);wrap.append(table);target.append(wrap);
}
function renderVideoLogsForm(){
 const controls=node('form',undefined,'login-log-controls'),dateLabel=node('label','查询日期（北京时间）'),dateInput=node('input'),openidLabel=node('label','玩家 openid（可选，精确匹配）'),openidInput=node('input'),placementLabel=node('label','视频广告点位（可选，精确匹配）'),placementInput=node('input'),search=node('button','查询'),clear=node('button','清除玩家筛选'),clearPlacement=node('button','清除点位筛选'),refresh=node('button','刷新'),result=node('div');
 controls.id='video-log-filter';result.id='video-log-results';dateInput.id='video-log-date';dateInput.type='date';dateInput.required=true;dateInput.value=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});dateLabel.htmlFor=dateInput.id;
 openidInput.id='video-log-openid';openidInput.type='text';openidInput.maxLength=128;openidInput.autocomplete='off';openidInput.placeholder='输入完整 openid，留空查询全部玩家';openidLabel.htmlFor=openidInput.id;
 placementInput.id='video-log-placement';placementInput.type='text';placementInput.autocomplete='off';placementInput.placeholder='例如 Main/LevelSkip，留空查询全部点位';placementLabel.htmlFor=placementInput.id;
 search.type='submit';clear.type=clearPlacement.type=refresh.type='button';
 const query=()=>loadVideoLogs(0,result,dateInput.value,openidInput.value||null,placementInput.value||null);
 controls.addEventListener('submit',event=>{event.preventDefault();query();});dateInput.addEventListener('change',query);refresh.addEventListener('click',query);
 dateInput.addEventListener('input',()=>{requestGeneration++;result.replaceChildren(node('p',dateInput.value?'筛选条件已修改，请点击查询或按回车':'请选择查询日期',dateInput.value?'metric-detail':'error active'));});
 openidInput.addEventListener('input',()=>{requestGeneration++;result.replaceChildren(node('p','筛选条件已修改，请点击查询或按回车','metric-detail'));});
 clear.addEventListener('click',()=>{openidInput.value='';query();});
 placementInput.addEventListener('input',()=>{requestGeneration++;result.replaceChildren(node('p','筛选条件已修改，请点击查询或按回车','metric-detail'));});
 clearPlacement.addEventListener('click',()=>{placementInput.value='';query();});
 controls.append(dateLabel,dateInput,openidLabel,openidInput,placementLabel,placementInput,search,clear,clearPlacement,refresh);
 view.append(node('p','视频日志按北京时间日期查询，默认当天；openid 留空查询全部玩家，填写完整值只查询该玩家在所选日期的记录。视频广告点位留空查询全部点位，填写完整值精确匹配（区分大小写），可与日期、玩家组合筛选。每个已入库的视频完成上报事件单独一行，按时间倒序展示；时间为服务端记录入库时间，不是客户端播放或发奖时间，不代表广告平台核实的有效播放。昵称为当前资料，不是上报时的昵称快照。','coverage-notice'),controls,result);
 query();
}
async function loadVideoLogs(offset,target,date,openid=null,placement=null){
 const generation=++requestGeneration,isCurrent=()=>loggedIn&&tab==='videoLogs'&&generation===requestGeneration;
 if(!date){target.replaceChildren(node('p','请选择查询日期','error active'));return;}
 if(openid!==null&&!/^[A-Za-z0-9_-]{1,128}$/.test(openid)){target.replaceChildren(node('p',messages.INVALID_OPENID,'error active'));return;}
 if(placement!==null&&([...placement].length<1||[...placement].length>64||placement.trim()!==placement||/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(placement))){target.replaceChildren(node('p',messages.INVALID_PLACEMENT,'error active'));return;}
 target.replaceChildren(node('p','正在加载视频日志…','loading'));
 try{const data=await api('video-logs',{offset,date,...(openid===null?{}:{openid}),...(placement===null?{}:{placement})},isCurrent);if(isCurrent())renderVideoLogs(data,target,openid,placement);}
 catch(error){if(isCurrent())target.replaceChildren(node('p',error.message,'error active'));}
}
function renderVideoLogs(data,target,openid=data.openid??null,placement=data.placement??null){
 const date=data.date??data.today;
 target.replaceChildren(node('p',`北京时间 ${date} · 共 ${data.total} 条 · ${openid===null?'全部玩家':'玩家 '+openid} · ${placement===null?'全部点位':'点位 '+placement} · 更新于 ${fmtDate(data.generatedAt)}`,'metric-detail'));
 const wrap=node('div',undefined,'history-table-container'),table=node('table',undefined,'history-table video-logs-table'),head=node('thead'),header=node('tr'),body=node('tbody');
 for(const title of ['时间（北京时间）','openid','昵称','视频广告点位'])header.append(node('th',title));head.append(header);
 for(const item of data.items){const row=node('tr');row.append(node('td',fmtDate(item.recordedAt)),node('td',item.openid),node('td',item.nickname||'—'),node('td',item.placement??'—'));body.append(row);}
 if(!data.items.length){const row=node('tr'),cell=node('td',openid===null?'所选日期暂无已上报的视频完成记录':'所选日期该玩家暂无已上报的视频完成记录');cell.colSpan=4;row.append(cell);body.append(row);}
 table.append(head,body);wrap.append(table);
 const controls=node('div',undefined,'login-log-controls'),previous=node('button','上一页'),next=node('button','下一页');previous.type=next.type='button';previous.disabled=data.offset===0;next.disabled=!data.hasMore;
 previous.addEventListener('click',()=>loadVideoLogs(Math.max(0,data.offset-data.limit),target,date,openid,placement));next.addEventListener('click',()=>loadVideoLogs(data.offset+data.limit,target,date,openid,placement));
 controls.append(previous,node('span',`第 ${Math.floor(data.offset/data.limit)+1} 页 · 每页 ${data.limit} 条`),next);target.append(wrap,controls);
}
function renderLoginLogsForm(){
 const controls=node('form',undefined,'login-log-controls'),label=node('label','查询日期（北京时间）'),dateInput=node('input'),openidLabel=node('label','玩家 openid（可选，精确匹配）'),openidInput=node('input'),searchButton=node('button','查询'),clearButton=node('button','清除玩家筛选'),refreshButton=node('button','刷新'),result=node('div');
 result.id='login-log-results';dateInput.id='login-log-date';dateInput.type='date';dateInput.required=true;dateInput.value=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});label.htmlFor=dateInput.id;refreshButton.type='button';
 openidInput.id='login-log-openid';openidInput.type='text';openidInput.maxLength=128;openidInput.autocomplete='off';openidInput.placeholder='输入完整 openid，留空查询全部玩家';openidLabel.htmlFor=openidInput.id;searchButton.type='submit';clearButton.type='button';
 const query=()=>loadLoginLogs(0,result,dateInput.value,openidInput.value||null);dateInput.addEventListener('change',query);refreshButton.addEventListener('click',query);
 controls.addEventListener('submit',event=>{event.preventDefault();return query();});
 openidInput.addEventListener('input',()=>{requestGeneration++;result.replaceChildren(node('p','筛选条件已修改，请点击查询或按回车','metric-detail'));});
 clearButton.addEventListener('click',()=>{openidInput.value='';return query();});
 controls.append(label,dateInput,openidLabel,openidInput,searchButton,clearButton,refreshButton);view.append(node('p','按北京时间日期查询成功登录记录，默认当天，切换日期自动查询；openid 可选，输入完整值只查询该玩家，留空查询全部玩家。查询、切换日期或清除玩家筛选均从第一页开始，翻页保留已查询的日期和 openid。按登录时间倒序，同一时间按用户 ID 倒序。每次成功登录单独一行：本次登录场景为该次登录上报的 scene，未上报或采集前的历史逐日记录显示“—”，不推测、不补造；首次来源场景仍是用户首次上报的来源，不代表本次登录。采集逐次事件之前的历史逐日首次登录按原有覆盖并入列表，已有逐次记录的登录不会重复计入。登录日志用于排查逐次登录，不改变也不影响活跃（DAU）统计口径。首次来源场景与本次登录场景均仅显示场景 ID，悬停可查看完整描述。客户端版本为最近一次成功登录上报的版本，并非该条历史登录的版本快照；未上报显示“—”。北京时间今天注册的玩家以整行绿色标识，按服务端当前日期判断，不随查询日期改变；跨日后点击刷新更新标识。点击刷新重新查询所选日期。','coverage-notice'),controls,result);query();
}
async function loadLoginLogs(offset,target,date,openid=null){const generation=++requestGeneration,isCurrent=()=>loggedIn&&tab==='loginLogs'&&generation===requestGeneration;if(!date){target.replaceChildren(node('p','请选择查询日期','error active'));return;}if(openid!==null&&!/^[A-Za-z0-9_-]{1,128}$/.test(openid)){target.replaceChildren(node('p',messages.INVALID_OPENID,'error active'));return;}target.replaceChildren(node('p','正在加载登录记录…','loading'));try{const data=await api('login-logs',{offset,date,...(openid===null?{}:{openid})},isCurrent);if(isCurrent())renderLoginLogs(data,target,openid);}catch(err){if(isCurrent())target.replaceChildren(node('p',err.message,'error active'));}}
function renderLoginLogs(data,target,openid=data.openid??null){const date=data.date??data.today;target.replaceChildren(node('p',`北京时间 ${date} · 共 ${data.total} 条 · ${openid===null?'全部玩家':'玩家 '+openid} · 更新于 ${fmtDate(data.generatedAt)}`,'metric-detail'));const wrap=node('div',undefined,'history-table-container'),table=node('table',undefined,'history-table login-logs-table'),head=node('thead'),header=node('tr'),body=node('tbody');for(const title of ['登录时间（北京时间）','openid','昵称','客户端版本','本次登录场景','首次来源场景','注册时间（北京时间）'])header.append(node('th',title));head.append(header);for(const item of data.items){const registeredToday=typeof item.registeredAt==='string'&&Number.isFinite(Date.parse(item.registeredAt))&&new Date(item.registeredAt).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})===data.today;const row=node('tr',undefined,registeredToday?'login-log-new-user':'');row.append(node('td',fmtDate(item.loginAt)),node('td',item.openid),node('td',item.nickname||'—'),node('td',item.clientVersion??'—'),sceneCell(item.loginScene),sceneCell(item.sourceScene,'未上报'),node('td',fmtDate(item.registeredAt)));body.append(row);}if(!data.items.length){const row=node('tr'),cell=node('td',openid===null?'所选日期暂无成功登录记录':'所选日期该玩家暂无成功登录记录');cell.colSpan=7;row.append(cell);body.append(row);}table.append(head,body);wrap.append(table);const controls=node('div',undefined,'login-log-controls'),previous=node('button','上一页'),next=node('button','下一页');previous.type=next.type='button';previous.disabled=data.offset===0;next.disabled=!data.hasMore;previous.addEventListener('click',()=>loadLoginLogs(Math.max(0,data.offset-data.limit),target,date,openid));next.addEventListener('click',()=>loadLoginLogs(data.offset+data.limit,target,date,openid));controls.append(previous,node('span',`第 ${Math.floor(data.offset/data.limit)+1} 页 · 每页 ${data.limit} 条`),next);target.append(wrap,controls);}
function renderPlayerForm(){
 const form=node('form',undefined,'player-form');form.id='player-form';
 const modeGroup=node('div',undefined,'form-group'),modeLabel=node('label','查询方式'),mode=node('select');
 mode.id='player-query-type';modeLabel.htmlFor=mode.id;
 for(const [value,text] of [['openid','openid'],['uid','UID']]){const option=node('option',text);option.value=value;mode.append(option);}mode.value='openid';modeGroup.append(modeLabel,mode);
 const group=node('div',undefined,'form-group'),label=node('label'),input=node('input');label.htmlFor='openid-input';input.id='openid-input';input.required=true;input.autocomplete='off';group.append(label,input);
 const button=node('button','只读查询');button.type='submit';const error=node('div',undefined,'error'),result=node('div',undefined,'player-result active');result.id='player-result';error.id='player-error';form.append(modeGroup,group,button,error);view.append(node('p','仅查询正式环境，支持完整 openid 或 UID 精确匹配，不提供修改、删除或发奖操作。','coverage-notice'),form,result);
 const updateMode=()=>{const isUid=mode.value==='uid';label.textContent=isUid?'玩家 UID（精确匹配）':'玩家 openid（精确匹配）';input.maxLength=isUid?36:128;input.placeholder=isUid?'请输入完整 UID（UUID）':'请输入完整 openid';};
 const invalidate=()=>{requestGeneration++;result.replaceChildren();error.textContent='';error.classList.remove('active');button.disabled=false;};
 mode.addEventListener('change',()=>{input.value='';updateMode();invalidate();});input.addEventListener('input',invalidate);updateMode();
 form.addEventListener('submit',async e=>{e.preventDefault();if(button.disabled)return;const generation=++requestGeneration;button.disabled=true;error.textContent='';error.classList.remove('active');result.replaceChildren();try{const data=await api('player',{[mode.value==='uid'?'uid':'openid']:input.value});if(loggedIn&&tab==='player'&&generation===requestGeneration)renderPlayer(data,result);}catch(err){if(loggedIn&&tab==='player'&&generation===requestGeneration){error.textContent=err.message;error.classList.add('active');}}finally{if(generation===requestGeneration)button.disabled=false;}});
}
function field(label,value){const box=node('div',undefined,'player-info-item');box.append(node('h4',label),node('p',value));return box;}
function renderPlayerRewardedVideos(data,target){
 const section=node('section');section.id='player-rewarded-videos';section.append(node('h3','激励视频'));
 if(!data){section.append(node('p','视频统计暂不可用','metric-detail'));target.append(section);return;}
 const grid=node('div',undefined,'metrics-grid');grid.append(metric('累计次数',data.total??'—'),metric('今日次数',data.today??'—','北京时间当日'));
 section.append(grid,field('首次记录（北京时间）',fmtDate(data.firstRecordedAt)),field('最近记录（北京时间）',fmtDate(data.lastRecordedAt)));
 const wrap=node('div',undefined,'history-table-container'),table=node('table',undefined,'history-table player-video-table'),head=node('thead'),header=node('tr'),body=node('tbody');
 for(const title of ['广告点位','累计次数','今日次数'])header.append(node('th',title));head.append(header);
 for(const item of data.placements){const row=node('tr');row.append(node('td',item.placement),node('td',item.total),node('td',item.today));body.append(row);}
 if(!data.placements.length){const row=node('tr'),cell=node('td','暂无已上报的视频完成记录');cell.colSpan=3;row.append(cell);body.append(row);}
 table.append(head,body);wrap.append(table);section.append(wrap,node('p','统计来自服务端已入库的视频完成事件，按事件去重；今日按北京时间自然日、服务端记录时间归属。不读取存档中的观看计数，不代表广告平台核实的有效播放量；未接入或未成功上报的观看不计入。重新查询可刷新统计。','metric-detail'));target.append(section);
}
function renderPlayer(data,target){const u=data.user,info=node('section',undefined,'player-info');for(const [key,value]of [['UID',u.id],['openid',u.openid],['昵称',u.nickname],['头像 URL',u.avatarUrl],['注册时间',fmtDate(u.registeredAt)],['最后登录',fmtDate(u.lastLoginAt)],['首次来源 scene',formatScene(u.sourceScene)],['来源上报时间',fmtDate(u.sourceReportedAt)]])info.append(field(key,value));target.append(info);renderPlayerRewardedVideos(data.rewardedVideos,target);
 const save=node('section',undefined,'raw-save-section');save.append(node('h3','完整原始云存档（只读）'),node('p',data.save.exists?`版本 ${data.save.version} · 更新时间 ${fmtDate(data.save.updatedAt)}`:'该用户暂未保存云存档','metric-detail'));const pre=node('pre',data.save.data??'','raw-save-pre');pre.id='raw-save';save.append(pre);if(data.save.exists){const actions=node('div',undefined,'raw-save-actions'),copy=node('button','复制原始存档','copy-btn'),download=node('button','下载原始存档','download-btn');copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(data.save.data);copy.textContent='已复制';}catch{copy.textContent='复制失败';}});download.addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([data.save.data],{type:'text/plain;charset=utf-8'})),a=node('a');a.href=url;a.download=`save_${u.id}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});actions.append(copy,download);save.append(actions);}target.append(save);
 const section=node('section',undefined,'invitation-summary'),summary=data.invitations.summary;section.append(node('h3','邀请信息'),node('p',data.inviter?`邀请人：${data.inviter.nickname||'未设置昵称'} · ${data.inviter.id}`:'邀请人：无'),node('p',`邀请总数 ${summary.total} · 已领取 ${summary.claimed} · 未领取 ${summary.unclaimed}`));if(data.inviter)section.append(node('pre',JSON.stringify(data.inviter,null,2)));if(data.invitations.items.length){const details=node('details');details.append(node('summary',`展开最近 ${data.invitations.items.length} 条邀请记录`),node('pre',JSON.stringify(data.invitations.items,null,2)));section.append(details);}if(data.invitations.truncated)section.append(node('p',`只展示最近 ${data.invitations.limit} 条，汇总为全部记录。`,'coverage-notice'));target.append(section);
 const history=node('section');history.append(node('h3','最近 30 次登录活跃日'));if(!data.dailyLogins.length)history.append(node('p','尚无逐日登录记录'));for(const d of data.dailyLogins)history.append(node('p',`${d.date} · 首次登录 ${fmtDate(d.firstLoginAt)}`));target.append(history);}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;try{await api('login',{username:$('username').value,password:$('password').value});showDashboard();}catch(err){$('login-error').textContent=err.message;$('login-error').classList.add('active');}finally{button.disabled=false;}});
$('logout-btn').addEventListener('click',async()=>{try{await api('logout',{});showLogin();}catch(e){if(loggedIn)alert('退出失败，请重试。');}});document.querySelectorAll('.nav-btn').forEach(e=>e.addEventListener('click',()=>switchView(e.dataset.view)));document.addEventListener('visibilitychange',()=>document.hidden?stop():start());api('me').then(showDashboard).catch(showLogin);
