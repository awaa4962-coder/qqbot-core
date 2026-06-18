import fs from 'fs';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, BorderStyle, ShadingType,
  PageOrientation
} from 'docx';

// ========== DATA ==========
const months = [
  {
    month: '2026年6月',
    desc: '当前月份，以下比赛仍在报名期',
    items: [
      { name: '四川省大学生工业设计大赛', type: '设计艺术类', org: '四川省教育厅', status: '🔥 报名中', deadline: '6月30日', desc: '主题"AI·ài·@i"，五大方向：智能体验/服务系统/文化社会/时尚生活/健康环保。明确接受高职高专学生参赛，免费，需通过学校集体报名。', url: 'scxkjs.moocollege.com', note: '国赛官网 cuidc.net' },
      { name: '第八届全国大学生工业设计大赛（四川赛区）', type: '设计艺术类', org: '教育部高等学校工业设计专业教学指导分委员会', status: '🔥 报名中', deadline: '6月30日', desc: '与省级大赛同步，分赛区评审7-8月，决赛9-10月。参赛对象含高职高专学生。', url: 'cuidc.net', note: '' },
      { name: '中国国际大学生创新大赛（2026）·职教赛道', type: '创新创业类', org: '教育部', status: '🔥 报名中', deadline: '约7月上旬', desc: '原"互联网+"大赛，含金量最高。设有职教赛道专门面向高职高专。全国4-7月报名，省级复赛后进国赛。需通过学校创新创业部门组队。', url: 'cy.ncss.cn', note: '大创网报名，具体截止以各校通知为准' },
      { name: '四川省大学生环境设计大赛 / "中装杯"四川赛区', type: '设计艺术类', org: '四川省教育厅', status: '📝 报名中', deadline: '待确认', desc: '在四川省普通本科高校学科竞赛平台上显示"报名中"。环境设计、室内设计方向。', url: 'scxkjs.moocollege.com', note: '建议尽快确认截止日期' },
      { name: '第十届全国大学生集成电路创新创业大赛·职业技能赛项', type: '职业技能类', org: '工信部人才交流中心', status: '📝 报名中', deadline: '6月30日', desc: '集成电路方向，设有职业技能专项赛道，大专生可参加。', url: 'saikr.com', note: '' },
      { name: '2026年"华青杯"AI机器人赛项', type: '科技创新类', org: '华青杯组委会', status: '📝 报名中', deadline: '6月28日', desc: '人工智能与机器人方向，大专生可组队参赛。', url: 'saikr.com', note: '' },
      { name: 'APMCM亚太地区大学生数学建模竞赛（中文赛项）', type: '学科竞赛类', org: 'APMCM组委会', status: '⏰ 今日截止', deadline: '6月12日', desc: '数学建模类，大专生可参加。如果今天还想报可能来不及了。', url: 'saikr.com', note: '已过截止日，仅作参考' },
    ]
  },
  {
    month: '2026年7月',
    desc: '暑期——部分比赛进入评审/省赛阶段，也是准备下半年赛事的好时机',
    items: [
      { name: '四川省大学生工业设计大赛（评审阶段）', type: '设计艺术类', org: '四川省教育厅', status: '🏃 省赛评审', deadline: '7月', desc: '6月30日截止提交后，7月进入省级评审阶段。已报名者关注结果。', url: 'scxkjs.moocollege.com', note: '' },
      { name: '中国国际大学生创新大赛（省赛阶段）', type: '创新创业类', org: '教育部', status: '🏃 省赛进行', deadline: '7-8月', desc: '职教赛道省级复赛安排在7-8月期间，具体时间由各省教育厅通知。通过校赛选拔后进入省赛。', url: 'cy.ncss.cn', note: '' },
      { name: '第八届全国大学生工业设计大赛（分赛区评审）', type: '设计艺术类', org: '教育部', status: '🏃 评审中', deadline: '7-8月', desc: '四川分赛区作品评审。', url: 'cuidc.net', note: '' },
      { name: '全国大学生电子设计竞赛', type: '学科竞赛类', org: '教育部、工信部', status: '📋 7月比赛', deadline: '通常7月底', desc: '电子信息类经典赛事。设有高职高专组，两年一届（偶数年举办）。需要关注学校是否组织参赛。', url: 'nuedc.org.cn', note: '偶数年举办，2026年应该有' },
      { name: '全国大学生化学实验创新设计大赛', type: '学科竞赛类', org: '教育部', status: '📋 区域赛', deadline: '7月', desc: '化学相关专业可关注。有高职组。', url: '', note: '需确认是否对大专生开放' },
    ]
  },
  {
    month: '2026年8月',
    desc: '暑期尾声——大赛全国阶段陆续启动',
    items: [
      { name: '中国国际大学生创新大赛（全国总决赛）', type: '创新创业类', org: '教育部', status: '🏆 全国赛', deadline: '8-10月', desc: '省级复赛优胜队伍晋级全国总决赛。职教赛道与高教主赛道分开评比。', url: 'cy.ncss.cn', note: '' },
      { name: '全国大学生电子设计竞赛（全国评审）', type: '学科竞赛类', org: '教育部、工信部', status: '🏆 全国评审', deadline: '8月', desc: '各省赛区选拔后进入全国评审。面向高职高专设有单独赛道。', url: 'nuedc.org.cn', note: '' },
      { name: '四川省职业院校技能大赛（2026）·筹备启动', type: '职业技能类', org: '四川省人社厅/教育厅', status: '📅 筹备中', deadline: '关注学校通知', desc: '四川省人社厅于2026年6月4日印发《2026年省级一类、二类职业技能竞赛计划》，各项赛事将在下半年陆续启动。这是高职大专生的核心赛事！关注四川职业教育技能创新中心（sicsve.cdp.edu.cn）。', url: 'sicsve.cdp.edu.cn', note: '重点推荐！大专生核心赛事' },
    ]
  },
  {
    month: '2026年9月',
    desc: '开学季——下半年最密集的比赛报名季',
    items: [
      { name: '全国大学生数学建模竞赛（CUMCM）·专科组', type: '学科竞赛类', org: '教育部、中国工业与应用数学学会', status: '📝 9月初报名', deadline: '约9月上旬报名，中旬比赛', desc: '含金量极高的数学建模赛事！设有专科组，大专生独立赛道。通常3天3夜完成论文。需通过学校组队报名（3人一队）。', url: 'mcm.edu.cn', note: '强力推荐！大专生有独立赛道' },
      { name: '四川省大学生工业设计大赛（决赛/颁奖）', type: '设计艺术类', org: '四川省教育厅', status: '🏆 决赛', deadline: '9-10月', desc: '省级决赛排名公布，颁奖典礼。获奖作品推荐参加全国赛。', url: 'scxkjs.moocollege.com', note: '' },
      { name: '中国国际大学生创新大赛（颁奖/成果转化）', type: '创新创业类', org: '教育部', status: '🏆 颁奖', deadline: '9-10月', desc: '全国总决赛颁奖。职教赛道金奖项目将获得国家级表彰。', url: 'cy.ncss.cn', note: '' },
      { name: '全国大学生数学竞赛', type: '学科竞赛类', org: '中国数学会', status: '📝 9月报名', deadline: '9月报名，10月初赛', desc: '数学专业比赛。部分高职院校可能参加非数学专业组。', url: '', note: '大专生视情况参加' },
      { name: '四川省各类职业技能竞赛（启动期）', type: '职业技能类', org: '四川省人社厅', status: '📝 陆续启动', deadline: '关注学校通知', desc: '根据6月4日印发的竞赛计划，一类、二类职业技能竞赛将在9月后集中启动。包括但不限于：数控技术、汽车维修、电子商务、烹饪、美容美发、网络安全等数十个赛项。', url: 'sicsve.cdp.edu.cn', note: '大专生最适合的赛道！' },
      { name: '四川省"挑战杯"课外学术科技作品竞赛（下一届筹备）', type: '创新创业类', org: '共青团中央', status: '📋 关注', deadline: '秋季启动', desc: '挑战杯通常校赛在9-11月启动，省赛次年3-5月。现在就可以开始准备！有科技发明制作、自然科学论文、哲学社科调查报告三大类。', url: 'tiaozhanbei.net', note: '提前准备，长期项目' },
    ]
  },
  {
    month: '2026年10月',
    desc: '金秋十月——创新创业与语言类赛事密集期',
    items: [
      { name: '"外研社·国才杯"全国英语演讲/写作/阅读大赛（专科组）', type: '学科竞赛类', org: '外研社', status: '📝 10月报名', deadline: '10月报名，11月省赛', desc: '最有影响力的英语赛事之一！设有专科组赛道，大专生独立排名。包括演讲、写作、阅读三个赛项。通过学校统一报名。', url: 'uchallenge.unipus.cn', note: '英语好的同学强力推荐！' },
      { name: '全国大学生英语竞赛（NECCS）·专科组', type: '学科竞赛类', org: '高等学校大学外语教学指导委员会', status: '📝 秋季初赛', deadline: '10-11月初赛', desc: '参赛人数最多的英语竞赛。设专科生组（D类），独立赛道。初赛在校内举行，决赛在省会城市。', url: 'chinaneco.cn', note: 'D类专科组，报名费约50元' },
      { name: '第六届全国大学生技术创新创业大赛', type: '创新创业类', org: '主办方待确认', status: '📝 报名中', deadline: '10月20日', desc: '技术创新创业方向，大专生可参加。全国性赛事。', url: 'saikr.com', note: '在赛氪平台报名' },
      { name: '"蓝桥杯"全国软件和信息技术专业人才大赛（报名启动）', type: '学科竞赛类', org: '工信部人才交流中心', status: '📝 10月报名', deadline: '10月报名，次年比赛', desc: '最有影响力的IT竞赛之一。设有Java、C/C++、Python、Web等多个赛项。分为研究生组、本科A/B组、高职高专组。', url: 'dasai.lanqiao.cn', note: 'IT方向强烈推荐！有高职组' },
      { name: '四川省职业院校技能大赛（集中比赛月）', type: '职业技能类', org: '四川省教育厅/人社厅', status: '🔥 比赛月', deadline: '10月', desc: '各项职业技能赛项集中在10-11月举办。提前通过学校报名参加各赛项的选拔和集训。', url: 'sicsve.cdp.edu.cn', note: '实操技能型的核心赛事' },
    ]
  },
  {
    month: '2026年11月',
    desc: '深秋——省赛决赛集中期',
    items: [
      { name: '"外研社·国才杯"四川省赛（专科组决赛）', type: '学科竞赛类', org: '外研社', status: '🏆 省赛', deadline: '11月', desc: '演讲/写作/阅读省级决赛。专科组独立排名，优胜者晋级全国总决赛。', url: 'uchallenge.unipus.cn', note: '' },
      { name: '全国大学生英语竞赛（NECCS）·决赛', type: '学科竞赛类', org: '高等学校大学外语教学指导委员会', status: '🏆 决赛', deadline: '11月', desc: '初赛选拔后进入省级决赛。专科组（D类）单独评奖。', url: 'chinaneco.cn', note: '' },
      { name: '四川省职业院校技能大赛（决赛阶段）', type: '职业技能类', org: '四川省人社厅', status: '🏆 决赛', deadline: '11月', desc: '各赛项决赛集中举办。获得名次可获省级技能证书+奖金。一等奖含金量极高，对就业和升学帮助大。', url: 'sicsve.cdp.edu.cn', note: '含金量极高！' },
      { name: '第六届全国大学生技术创新创业大赛', type: '创新创业类', org: '主办方', status: '🏃 评审', deadline: '11月', desc: '10月20日截止报名后进入评审阶段。', url: 'saikr.com', note: '' },
      { name: '"挑战杯"校赛阶段', type: '创新创业类', org: '共青团中央', status: '📝 校赛', deadline: '11-12月', desc: '备赛启动期，完成选题、组队和初步作品。校赛选拔通过后进入省赛。', url: 'tiaozhanbei.net', note: '为明年省赛做准备！' },
      { name: '全国大学生网络与信息安全大赛', type: '学科竞赛类', org: '教育部', status: '📋 比赛期', deadline: '11月左右', desc: '网络安全方向，大专生可参加（设有高职组）。CTF夺旗赛形式。', url: '', note: '网安方向同学关注' },
    ]
  },
  {
    month: '2026年12月',
    desc: '岁末——收尾与下一轮备赛',
    items: [
      { name: '"外研社·国才杯"全国总决赛（专科组）', type: '学科竞赛类', org: '外研社', status: '🏆 全国赛', deadline: '12月', desc: '各省专科组优胜选手齐聚全国决赛舞台。', url: 'uchallenge.unipus.cn', note: '' },
      { name: '全国职业院校技能大赛（2026）·部分赛项', type: '职业技能类', org: '教育部', status: '🏆 全国赛', deadline: '12月', desc: '国家级职业院校技能大赛，各省选拔出的优胜队伍参加全国总决赛。高职大专生最高水平的竞技舞台。', url: '', note: '最高级别的职业技能赛事' },
      { name: '"挑战杯"备赛关键期', type: '创新创业类', org: '共青团中央', status: '📋 备赛', deadline: '12月', desc: '校赛通过后进入省赛冲刺准备。打磨作品、完善材料、准备答辩。', url: 'tiaozhanbei.net', note: '为明年3-5月省赛做准备' },
      { name: '"蓝桥杯"报名收尾', type: '学科竞赛类', org: '工信部人才交流中心', status: '📝 报名截止', deadline: '12月', desc: '蓝桥杯报名通常在12月截止（各省时间不同）。高职高专组独立排名。', url: 'dasai.lanqiao.cn', note: '' },
      { name: '各类竞赛年度总结 & 次年规划', type: '综合', org: '—', status: '📋 规划', deadline: '12月', desc: '梳理当年参赛成果，规划2027年赛事。关注各项竞赛官网公布的次年赛程。', url: '', note: '做好规划，来年再战！' },
    ]
  },
];

// Format helpers
const typeColors = {
  '设计艺术类': '4472C4',
  '创新创业类': 'ED7D31',
  '职业技能类': '70AD47',
  '学科竞赛类': 'FFC000',
  '科技创新类': '5B9BD5',
  '综合': 'A5A5A5',
};

const typeEmoji = {
  '设计艺术类': '🎨',
  '创新创业类': '💡',
  '职业技能类': '🔧',
  '学科竞赛类': '📚',
  '科技创新类': '🔬',
  '综合': '📌',
};

function doc() {
  const children = [];

  // Title
  children.push(new Paragraph({
    text: '四川省未来半年省级比赛汇总（大专生可参加）',
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
  }));

  children.push(new Paragraph({
    children: [
      new TextRun({
        text: '搜索整理时间：2026年6月12日 ｜ 时间范围：2026年6月—12月（半年）',
        size: 22, color: '666666',
      }),
    ],
    alignment: AlignmentType.CENTER,
    spacing: { after: 100 },
  }));

  children.push(new Paragraph({
    children: [
      new TextRun({
        text: '⚠️ 免责说明：以下信息基于公开资料整理，部分竞赛时间参考往年规律推测（标注"约""通常"等字眼），具体以主办方及各校官方通知为准。建议及时关注学校教务处/创新创业学院/团委发布的正式通知。',
        size: 18, color: '999999', italics: true,
      }),
    ],
    spacing: { after: 400 },
  }));

  // Summary table
  children.push(new Paragraph({
    text: '📊 总览速查表',
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 300, after: 200 },
  }));

  const summaryRows = [
    ['月份', '重点赛事', '状态'],
    ...months.map(m => [
      m.month,
      m.items.slice(0, 3).map(i => i.name.replace(/（.*$/, '').replace(/\(.*$/, '')).join('、'),
      m.items.filter(i => i.status.includes('报名中') || i.status.includes('截止')).length > 0 ? '🟢 有报名中' : '🔵 进行中',
    ]),
  ];

  children.push(createTable(summaryRows, [1500, 5500, 1500], '4472C4'));

  // Monthly detail
  for (const monthData of months) {
    children.push(new Paragraph({
      text: `\n📅 ${monthData.month}`,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 400, after: 100 },
    }));
    children.push(new Paragraph({
      children: [new TextRun({ text: monthData.desc, italics: true, size: 20, color: '666666' })],
      spacing: { after: 200 },
    }));

    for (const item of monthData.items) {
      // Competition name as heading 2
      const emoji = typeEmoji[item.type] || '📋';
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${emoji} ${item.name}  `, bold: true, size: 24 }),
          new TextRun({ text: item.status, bold: true, size: 22, color: item.status.includes('报名中') || item.status.includes('截止') ? 'FF0000' : '4472C4' }),
        ],
        spacing: { before: 200, after: 80 },
      }));

      // Info lines
      const infoLines = [
        `📂 类别：${item.type}`,
        `🏛 主办：${item.org}`,
        item.deadline ? `⏰ 时间节点：${item.deadline}` : '',
        `📝 说明：${item.desc}`,
        item.url ? `🔗 官网/平台：${item.url}` : '',
        item.note ? `💡 提示：${item.note}` : '',
      ].filter(Boolean);

      for (const line of infoLines) {
        children.push(new Paragraph({
          children: [new TextRun({ text: line, size: 20 })],
          spacing: { after: 40 },
          indent: { left: 400 },
        }));
      }
    }
  }

  // Appendix: key websites
  children.push(new Paragraph({
    text: '\n🔗 附录：重要竞赛网站汇总',
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 500, after: 200 },
  }));

  const websites = [
    ['平台名称', '网址', '说明'],
    ['全国大学生创业服务网（大创网）', 'cy.ncss.cn', '中国国际大学生创新大赛官方报名入口'],
    ['赛氪竞赛网', 'saikr.com', '各类竞赛信息汇总，大专生可筛选'],
    ['四川省普通本科高校学科竞赛平台', 'scxkjs.moocollege.com', '四川省学科竞赛官方平台'],
    ['全国大学生工业设计大赛', 'cuidc.net', '工业设计大赛国赛官网'],
    ['全国大学生数学建模竞赛', 'mcm.edu.cn', '国赛报名和资讯'],
    ['外研社·国才杯大赛', 'uchallenge.unipus.cn', '英语演讲/写作/阅读大赛'],
    ['全国大学生英语竞赛', 'chinaneco.cn', 'NECCS英语竞赛'],
    ['蓝桥杯大赛', 'dasai.lanqiao.cn', 'IT类竞赛，有高职组'],
    ['挑战杯官方网站', 'tiaozhanbei.net', '挑战杯竞赛资讯'],
    ['四川职业教育技能创新中心', 'sicsve.cdp.edu.cn', '四川省职业院校技能大赛相关'],
    ['全国大学生电子设计竞赛', 'nuedc.org.cn', '电子设计竞赛官网'],
  ];
  children.push(createTable(websites, [2500, 3000, 3500], '70AD47'));

  // Tips section
  children.push(new Paragraph({
    text: '\n💡 参赛小贴士',
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 500, after: 200 },
  }));

  const tips = [
    '1. 🏫 学校渠道优先：大多数省级竞赛通过学校统一选拔报名，务必关注学校教务处/创新创业学院/团委通知。',
    '2. 👥 提前组队：数学建模、创新创业等赛事需要3-5人组队，建议提前物色队友。',
    '3. 📅 打好提前量：不要卡在截止日报名！很多比赛需要学校审核、盖章，预留至少1-2周。',
    '4. 🔍 善用赛氪(saikr.com)：按"省份""学历"筛选，可以找到大量适合大专生的竞赛。',
    '5. 🎯 聚焦优势赛事：职业技能类比赛是大专生最强项，建议作为重点突破口。',
    '6. 💰 注意费用：大部分省级竞赛免费或低费（几元到一百元），警惕高额报名费的商业赛事。',
    '7. 📂 保留证书：竞赛获奖证书对专升本加分、求职就业都有帮助，妥善保管。',
    '8. 🌟 金奖不是唯一目标：参与本身就是锻炼，优秀奖/三等奖同样有价值。',
  ];

  for (const tip of tips) {
    children.push(new Paragraph({
      children: [new TextRun({ text: tip, size: 20 })],
      spacing: { after: 60 },
    }));
  }

  // Footer
  children.push(new Paragraph({
    text: '\n— 夜星 🐱✨ 整理于 2026年6月12日 —',
    alignment: AlignmentType.CENTER,
    spacing: { before: 500 },
    children: [new TextRun({ text: '\n— 夜星 🐱✨ 整理于 2026年6月12日 —', size: 18, color: '999999', italics: true })],
  }));

  return new Document({
    sections: [{
      properties: {
        page: {
          margin: { top: 1000, bottom: 1000, left: 1200, right: 1200 },
        },
      },
      children,
    }],
  });
}

function createTable(rows, widths, headerColor) {
  const [header, ...data] = rows;

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      // Header row
      new TableRow({
        tableHeader: true,
        children: header.map((cell, i) => new TableCell({
          width: { size: widths[i], type: WidthType.DXA },
          shading: { type: ShadingType.SOLID, color: headerColor },
          children: [new Paragraph({
            children: [new TextRun({ text: cell, bold: true, color: 'FFFFFF', size: 20 })],
            alignment: AlignmentType.CENTER,
          })],
        })),
      }),
      // Data rows
      ...data.map((row, ri) => new TableRow({
        shading: ri % 2 === 0 ? { type: ShadingType.SOLID, color: 'F2F2F2' } : undefined,
        children: row.map((cell, ci) => new TableCell({
          width: { size: widths[ci], type: WidthType.DXA },
          children: [new Paragraph({
            children: [new TextRun({ text: cell, size: 18 })],
            alignment: ci === 0 ? AlignmentType.CENTER : AlignmentType.LEFT,
          })],
        })),
      })),
    ],
  });
}

// Generate
(async () => {
  const outPath = 'C:\\Users\\asus\\.openclaw\\workspace\\qqfriend\\四川大专生省级比赛汇总_2026下半年.docx';
  const buffer = await Packer.toBuffer(doc());
  fs.writeFileSync(outPath, buffer);
  console.log('✅ Word document saved to:', outPath);
  console.log(`   File size: ${(buffer.length / 1024).toFixed(1)} KB`);
})();
