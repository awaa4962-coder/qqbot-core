$word = New-Object -ComObject Word.Application
$word.Visible = $false
$doc = $word.Documents.Add()

$doc.PageSetup.TopMargin = 72
$doc.PageSetup.BottomMargin = 72
$doc.PageSetup.LeftMargin = 90
$doc.PageSetup.RightMargin = 90

$sel = $word.Selection

# === TITLE ===
$sel.Font.Name = '黑体'
$sel.Font.Size = 22
$sel.Font.Bold = $true
$sel.ParagraphFormat.Alignment = 1
$sel.ParagraphFormat.SpaceAfter = 6
$sel.TypeText('鹤鸣山上那抹红')
$sel.TypeParagraph()

# === SUBTITLE ===
$sel.Font.Name = '楷体'
$sel.Font.Size = 14
$sel.Font.Bold = $false
$sel.ParagraphFormat.Alignment = 1
$sel.ParagraphFormat.SpaceAfter = 12
$sel.TypeText('王志扬 | 四川西南航空职业学院 | 飞机机电设备维修专业 | 金堂水城救援队志愿者')
$sel.TypeParagraph()
$sel.TypeParagraph()

# === BODY ===
$bodyFont = '仿宋'
$bodySize = 16

function WriteBody($text) {
    $script:sel.Font.Name = $script:bodyFont
    $script:sel.Font.Size = $script:bodySize
    $script:sel.Font.Bold = $false
    $script:sel.ParagraphFormat.Alignment = 0
    $script:sel.ParagraphFormat.FirstLineIndent = 32
    $script:sel.ParagraphFormat.LineSpacingRule = 1
    $script:sel.ParagraphFormat.LineSpacing = 28
    $script:sel.TypeText($text)
    $script:sel.TypeParagraph()
}

function WriteDialogue($text) {
    $script:sel.Font.Name = $script:bodyFont
    $script:sel.Font.Size = $script:bodySize
    $script:sel.Font.Bold = $false
    $script:sel.ParagraphFormat.Alignment = 0
    $script:sel.ParagraphFormat.FirstLineIndent = 32
    $script:sel.ParagraphFormat.LineSpacingRule = 1
    $script:sel.ParagraphFormat.LineSpacing = 28
    $script:sel.TypeText($text)
    $script:sel.TypeParagraph()
}

function WriteBlank() {
    $script:sel.TypeParagraph()
}

WriteBody '十二月的成都，冬天是那种潮乎乎的冷。'
WriteBlank
WriteBody '凌晨五点，闹钟响的时候天还没亮。室友翻了个身嘟囔了一句"又去啊"，我没应声，摸黑套上那件红色的救援队服，背上包出了门。'
WriteBlank
WriteBody '我叫王志扬，四川西南航空职业学院飞机机电设备维修专业的学生。每天在实训车间里跟发动机、液压管路打交道，学的是怎么让飞机安全地飞上天。但今天，我要去的是大邑鹤鸣山，去做一件和修飞机完全无关的事——给一场超级山径赛当安全保障志愿者。'
WriteBlank
WriteBody '摆渡车在高速上跑了快一个半小时。车窗外的天色从黑变灰，再到远处山脊上透出一线金光。到达道源圣城景区的时候，山里的雾气还没散完，竹林和古柏在晨雾里若隐若现，空气冷得扎脸。'
WriteBlank
WriteBody '我是跟着金堂水城救援队一起来的。我们这支队伍，说大不大，说小不小，从河南水灾到疫情防控，这些年什么急难险重的活儿都接过。出发前队长拍着我的肩膀说："小王，你是学修飞机的，心细，今天你就守在龙窝子那边，那个路段坡陡路滑，37公里组的选手跑到那里的时候体能已经消耗得差不多了，容易出事。"'
WriteBlank
WriteBody '我说好。'
WriteBlank
WriteBody '背上急救包、拿上对讲机，我一个人走到了龙窝子那个转弯处。溪水在脚边哗哗地流，山里的风从谷口灌进来，冷得人直跺脚。我把保温毯、绷带、葡萄糖水一样一样从包里掏出来摆在石头台子上，又把队旗插在了显眼的地方——红色的旗子，跟我的队服一个颜色。'
WriteBlank
WriteBody '上午十点半左右，第一个37公里组的选手出现在山路上。'
WriteBlank
WriteBody '那是个三十多岁的男的，跑得还算稳，经过我的时候喘着气冲我竖了个大拇指。我喊了一声"加油，前面有补给站"，他点点头继续往前跑。接下来的两个小时里，选手们陆陆续续经过——有跑得快的，冲过的时候只有一阵风声；有跑得慢的，脸上的表情像是在跟自己的身体谈判。'
WriteBlank
WriteBody '真正紧张的是十一点多。对讲机里队友说前面有个选手状态不太好，让我留神。没过几分钟，一个二十出头的女生转过弯道的时候，步子已经踉跄了。她脸色发白，嘴唇没一点血色，两条腿抖得像筛糠。'
WriteBlank
WriteBody '我赶紧迎上去扶住她。'
WriteBlank
WriteDialogue '"坐，先坐下。"'
WriteBlank
WriteBody '她靠在路边的石头上，整个人都在发抖。我摸了摸她的手——冰得吓人。失温。我马上把保温毯抖开裹在她身上，又从保温壶里倒了杯热水递过去。她捧着杯子喝了两口，水洒了一半——手抖得根本端不稳。'
WriteBlank
WriteDialogue '"抽筋……"她指着右小腿，声音细得像蚊子。'
WriteBlank
WriteBody '我把她的腿放平，慢慢做拉伸。一边拉一边跟她聊天——问她从哪里来、跑了多久了、前面的风景怎么样。其实不是为了聊天，就是不能让她睡过去。失温加上极度疲劳，人一旦闭上眼睛，就可能再也睁不开了。'
WriteBlank
WriteBody '过了大概十分钟，她的手终于没那么冰了，脸上的血色回来了一点。我让对讲机通知前面的救援组来接应，然后把她慢慢扶起来。'
WriteBlank
WriteDialogue '"还能走吗？"'
WriteBlank
WriteBody '她点点头。我陪她慢慢走了一段，直到下一组队友接上。'
WriteBlank
WriteBody '她走的时候回头看了我一眼，说了句"谢谢"。'
WriteBlank
WriteBody '不是什么惊天动地的事。'
WriteBlank
WriteBody '就是一杯热水、一条保温毯、十分钟的拉伸、一段陪着走的路。但那一刻我突然觉得，这跟我学的专业其实有那么一点像。修飞机，是为了飞机能安全地飞上天；做救援，是为了人能安全地回到家。本质都是守护。'
WriteBlank
WriteBody '下午三点多，关门时间到了。赛道上的选手全部安全完赛，我和队友们收队下山。路过道源圣城景区门口的时候，正好赶上闭幕式。一个完赛的选手——我帮她处理过抽筋的——冲我招了招手，笑着说谢谢。'
WriteBlank
WriteBody '她的手已经不抖了。'
WriteBlank
WriteBody '我想，这大概就是"红十字"在我心里最真实的样子。'
WriteBlank
WriteBody '不是印在旗帜上的那个符号，也不是教科书里那段冗长的定义。是山路上递出去的那杯热水，是裹在陌生人身上的那条保温毯，是寒风里站六个小时的那身红色队服。'
WriteBlank
WriteBody '我学的是飞机机电设备维修，以后大概率会去机场、去航空公司，跟扳手和仪表盘打一辈子交道。但我永远不会忘了2025年12月7日这一天——那天我没有修飞机，但我守护了一些人，让他们安全地回到了家。'
WriteBlank
WriteBody '这就是我心中的红十字。它不在天花板上，不在讲稿里，它在每一个愿意伸出手的普通人身上。在寒风中，在山路上，在每一个被需要的时候，红得干干净净。'

# === AUTHOR INFO ===
WriteBlank
WriteBlank
$sel.Font.Name = '楷体'
$sel.Font.Size = 14
$sel.Font.Bold = $false
$sel.ParagraphFormat.Alignment = 2
$sel.ParagraphFormat.FirstLineIndent = 0
$sel.TypeText('作者：王志扬')
$sel.TypeParagraph()
$sel.TypeText('单位：四川西南航空职业学院 飞机机电设备维修专业')
$sel.TypeParagraph()
$sel.TypeText('志愿者组织：金堂水城救援队')
$sel.TypeParagraph()
$sel.TypeText('联系电话：___________')
$sel.TypeParagraph()

# Save
$filepath = 'C:\Users\asus\.openclaw\workspace\qqfriend\金堂水城救援队_王志扬_鹤鸣山上那抹红.docx'
$doc.SaveAs([ref]$filepath)
$doc.Close()
$word.Quit()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
Write-Host 'DONE: ' $filepath
