const docx = require("docx");
const fs = require("fs");

const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, HeadingLevel, LineRuleType
} = docx;

// Helper: body paragraph with first-line indent
function bodyPara(text) {
  return new Paragraph({
    spacing: { line: 400, lineRule: LineRuleType.AUTO },
    indent: { firstLine: 640 },
    children: [
      new TextRun({ text, font: "仿宋", size: 32 }) // 16pt = 32 half-pt
    ]
  });
}

// Helper: dialogue paragraph
function dialoguePara(text) {
  return new Paragraph({
    spacing: { line: 400, lineRule: LineRuleType.AUTO },
    indent: { firstLine: 640 },
    children: [
      new TextRun({ text, font: "仿宋", size: 32 })
    ]
  });
}

// Helper: blank line
function blankLine() {
  return new Paragraph({
    spacing: { line: 400 },
    children: [new TextRun({ text: "", size: 32 })]
  });
}

// Helper: right-aligned info line
function infoRight(text) {
  return new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { line: 360 },
    children: [
      new TextRun({ text, font: "楷体", size: 28 })
    ]
  });
}

const doc = new Document({
  sections: [{
    properties: {
      page: {
        margin: { top: 1440, bottom: 1440, left: 1800, right: 1800 }
      }
    },
    children: [
      // === TITLE ===
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [
          new TextRun({ text: "鹤鸣山上那抹红", font: "黑体", size: 44, bold: true }) // 22pt
        ]
      }),

      // === SUBTITLE ===
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [
          new TextRun({
            text: "王志扬 | 四川西南航空职业学院 | 飞机机电设备维修专业 | 金堂水城救援队志愿者",
            font: "楷体", size: 28 // 14pt
          })
        ]
      }),

      blankLine(),

      // === BODY ===
      bodyPara("十二月的成都，冬天是那种潮乎乎的冷。"),
      blankLine(),
      bodyPara("凌晨五点，闹钟响的时候天还没亮。室友翻了个身嘟囔了一句\u201C又去啊\u201D，我没应声，摸黑套上那件红色的救援队服，背上包出了门。"),
      blankLine(),
      bodyPara("我叫王志扬，四川西南航空职业学院飞机机电设备维修专业的学生。每天在实训车间里跟发动机、液压管路打交道，学的是怎么让飞机安全地飞上天。但今天，我要去的是大邑鹤鸣山，去做一件和修飞机完全无关的事\u2014\u2014给一场超级山径赛当安全保障志愿者。"),
      blankLine(),
      bodyPara("摆渡车在高速上跑了快一个半小时。车窗外的天色从黑变灰，再到远处山脊上透出一线金光。到达道源圣城景区的时候，山里的雾气还没散完，竹林和古柏在晨雾里若隐若现，空气冷得扎脸。"),
      blankLine(),
      bodyPara("我是跟着金堂水城救援队一起来的。我们这支队伍，说大不大，说小不小，从河南水灾到疫情防控，这些年什么急难险重的活儿都接过。出发前队长拍着我的肩膀说：\u201C小王，你是学修飞机的，心细，今天你就守在龙窝子那边，那个路段坡陡路滑，37公里组的选手跑到那里的时候体能已经消耗得差不多了，容易出事。\u201D"),
      blankLine(),
      bodyPara("我说好。"),
      blankLine(),
      bodyPara("背上急救包、拿上对讲机，我一个人走到了龙窝子那个转弯处。溪水在脚边哗哗地流，山里的风从谷口灌进来，冷得人直跺脚。我把保温毯、绷带、葡萄糖水一样一样从包里掏出来摆在石头台子上，又把队旗插在了显眼的地方\u2014\u2014红色的旗子，跟我的队服一个颜色。"),
      blankLine(),
      bodyPara("上午十点半左右，第一个37公里组的选手出现在山路上。"),
      blankLine(),
      bodyPara("那是个三十多岁的男的，跑得还算稳，经过我的时候喘着气冲我竖了个大拇指。我喊了一声\u201C加油，前面有补给站\u201D，他点点头继续往前跑。接下来的两个小时里，选手们陆陆续续经过\u2014\u2014有跑得快的，冲过的时候只有一阵风声；有跑得慢的，脸上的表情像是在跟自己的身体谈判。"),
      blankLine(),
      bodyPara("真正紧张的是十一点多。对讲机里队友说前面有个选手状态不太好，让我留神。没过几分钟，一个二十出头的女生转过弯道的时候，步子已经踉跄了。她脸色发白，嘴唇没一点血色，两条腿抖得像筛糠。"),
      blankLine(),
      bodyPara("我赶紧迎上去扶住她。"),
      blankLine(),
      dialoguePara("\u201C坐，先坐下。\u201D"),
      blankLine(),
      bodyPara("她靠在路边的石头上，整个人都在发抖。我摸了摸她的手\u2014\u2014冰得吓人。失温。我马上把保温毯抖开裹在她身上，又从保温壶里倒了杯热水递过去。她捧着杯子喝了两口，水洒了一半\u2014\u2014手抖得根本端不稳。"),
      blankLine(),
      dialoguePara("\u201C抽筋\u2026\u2026\u201D她指着右小腿，声音细得像蚊子。"),
      blankLine(),
      bodyPara("我把她的腿放平，慢慢做拉伸。一边拉一边跟她聊天\u2014\u2014问她从哪里来、跑了多久了、前面的风景怎么样。其实不是为了聊天，就是不能让她睡过去。失温加上极度疲劳，人一旦闭上眼睛，就可能再也睁不开了。"),
      blankLine(),
      bodyPara("过了大概十分钟，她的手终于没那么冰了，脸上的血色回来了一点。我让对讲机通知前面的救援组来接应，然后把她慢慢扶起来。"),
      blankLine(),
      dialoguePara("\u201C还能走吗？\u201D"),
      blankLine(),
      bodyPara("她点点头。我陪她慢慢走了一段，直到下一组队友接上。"),
      blankLine(),
      bodyPara("她走的时候回头看了我一眼，说了句\u201C谢谢\u201D。"),
      blankLine(),
      bodyPara("不是什么惊天动地的事。"),
      blankLine(),
      bodyPara("就是一杯热水、一条保温毯、十分钟的拉伸、一段陪着走的路。但那一刻我突然觉得，这跟我学的专业其实有那么一点像。修飞机，是为了飞机能安全地飞上天；做救援，是为了人能安全地回到家。本质都是守护。"),
      blankLine(),
      bodyPara("下午三点多，关门时间到了。赛道上的选手全部安全完赛，我和队友们收队下山。路过道源圣城景区门口的时候，正好赶上闭幕式。一个完赛的选手\u2014\u2014我帮她处理过抽筋的\u2014\u2014冲我招了招手，笑着说谢谢。"),
      blankLine(),
      bodyPara("她的手已经不抖了。"),
      blankLine(),
      bodyPara("我想，这大概就是\u201C红十字\u201D在我心里最真实的样子。"),
      blankLine(),
      bodyPara("不是印在旗帜上的那个符号，也不是教科书里那段冗长的定义。是山路上递出去的那杯热水，是裹在陌生人身上的那条保温毯，是寒风里站六个小时的那身红色队服。"),
      blankLine(),
      bodyPara("我学的是飞机机电设备维修，以后大概率会去机场、去航空公司，跟扳手和仪表盘打一辈子交道。但我永远不会忘了2025年12月7日这一天\u2014\u2014那天我没有修飞机，但我守护了一些人，让他们安全地回到了家。"),
      blankLine(),
      bodyPara("这就是我心中的红十字。它不在天花板上，不在讲稿里，它在每一个愿意伸出手的普通人身上。在寒风中，在山路上，在每一个被需要的时候，红得干干净净。"),

      blankLine(),
      blankLine(),

      // === AUTHOR INFO ===
      infoRight("作者：王志扬"),
      infoRight("单位：四川西南航空职业学院  飞机机电设备维修专业"),
      infoRight("志愿者组织：金堂水城救援队"),
      infoRight("联系电话：___________"),
    ]
  }]
});

const outPath = "C:\\Users\\asus\\.openclaw\\workspace\\qqfriend\\金堂水城救援队_王志扬_鹤鸣山上那抹红.docx";
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(outPath, buf);
  console.log("DONE:", outPath);
}).catch(err => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
