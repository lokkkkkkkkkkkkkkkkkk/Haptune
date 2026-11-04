// Built-in songbook: public-domain melodies with chord symbols and lyrics, written in ABC notation.
// Titles are given in English, Malay, Simplified and Traditional Chinese.
export const SONGS = [
  {
    id: 'twinkle', level: 1, tags: ['kids', 'beginner'], instrument: 'any',
    titles: { en: 'Twinkle, Twinkle, Little Star', ms: 'Twinkle, Twinkle, Little Star', 'zh-Hans': '小星星', 'zh-Hant': '小星星' },
    abc: `X:1
T:Twinkle, Twinkle, Little Star
C:Traditional
M:4/4
L:1/4
Q:1/4=96
K:C
"C"C C G G|"F"A A "C"G2|"F"F F "C"E E|"G"D D "C"C2|
w:Twin-kle, twin-kle, lit-tle star, how I won-der what you are!
"C"G G "F"F F|"C"E E "G"D2|"C"G G "F"F F|"C"E E "G"D2|
w:Up a-bove the world so high, like a dia-mond in the sky.
"C"C C G G|"F"A A "C"G2|"F"F F "C"E E|"G"D D "C"C2|]
w:Twin-kle, twin-kle, lit-tle star, how I won-der what you are!`,
  },
  {
    id: 'mary', level: 1, tags: ['kids', 'beginner'], instrument: 'any',
    titles: { en: 'Mary Had a Little Lamb', ms: 'Mary Had a Little Lamb', 'zh-Hans': '玛丽有只小羊羔', 'zh-Hant': '瑪麗有隻小羊羔' },
    abc: `X:2
T:Mary Had a Little Lamb
C:Traditional
M:4/4
L:1/4
Q:1/4=100
K:C
"C"E D C D|E E E2|"G"D D D2|"C"E G G2|
w:Ma-ry had a lit-tle lamb, lit-tle lamb, lit-tle lamb,
"C"E D C D|E E E E|"G"D D E D|"C"C4|]
w:Ma-ry had a lit-tle lamb, its fleece was white as snow.`,
  },
  {
    id: 'tigers', level: 1, tags: ['kids', 'beginner', 'chinese'], instrument: 'any',
    titles: { en: 'Two Tigers (Frère Jacques)', ms: 'Dua Ekor Harimau (Frère Jacques)', 'zh-Hans': '两只老虎', 'zh-Hant': '兩隻老虎' },
    abc: `X:3
T:Two Tigers (Frère Jacques)
C:Traditional
M:4/4
L:1/4
Q:1/4=104
K:C
"C"C D E C|C D E C|E F G2|E F G2|
w:两 只 老 虎， 两 只 老 虎， 跑 得 快， 跑 得 快，
w:Are you sleep-ing, are you sleep-ing, Bro-ther John? Bro-ther John?
"C"G/A/G/F/ E C|G/A/G/F/ E C|"C"C "G"G, "C"C2|"C"C "G"G, "C"C2|]
w:一 只 没 有 耳 朵， 一 只 没 有 尾 巴， 真 奇 怪！ 真 奇 怪！
w:Morn-ing bells are ring-ing, morn-ing bells are ring-ing, ding, dang, dong! Ding, dang, dong!`,
  },
  {
    id: 'odetojoy', level: 1, tags: ['classical', 'beginner'], instrument: 'any',
    titles: { en: 'Ode to Joy', ms: 'Ode to Joy', 'zh-Hans': '欢乐颂', 'zh-Hant': '歡樂頌' },
    abc: `X:4
T:Ode to Joy
C:Ludwig van Beethoven
M:4/4
L:1/4
Q:1/4=100
K:D
"D"F F G A|"A"A G F E|"D"D D E F|"A"F3/2 E/ E2|
w:Freu-de, schö-ner Göt-ter-fun-ken, Toch-ter aus E-ly-si-um,
"D"F F G A|"A"A G F E|"D"D D E F|"A"E3/2 D/ "D"D2|
w:Wir be-tre-ten feu-er-trun-ken, Himm-li-sche, dein Hei-lig-tum!
"A"E E F D|"A"E F/G/ F D|"A"E F/G/ F E|"D"D E "A"A,2|
w:Dei-ne Zau-ber bin-den_ wie-der, was die_ Mo-de streng ge-teilt;
"D"F F G A|"A"A G F E|"D"D D E F|"A"E3/2 D/ "D"D2|]
w:al-le Men-schen wer-den Brü-der, wo dein sanf-ter Flü-gel weilt.`,
  },
  {
    id: 'birthday', level: 1, tags: ['celebration'], instrument: 'any',
    titles: { en: 'Happy Birthday', ms: 'Selamat Hari Jadi', 'zh-Hans': '生日快乐', 'zh-Hant': '生日快樂' },
    abc: `X:5
T:Happy Birthday
C:Mildred J. Hill & Patty Hill
M:3/4
L:1/4
Q:1/4=100
K:C
G3/4G/4|"C"A G c|"G"B2 G3/4G/4|"G"A G d|"C"c2 G3/4G/4|
w:Hap-py birth-day to you, Hap-py birth-day to you, Hap-py
"C"g e c|"F"B A f3/4f/4|"C"e c "G"d|"C"c2|]
w:birth-day dear Al-ex, Hap-py birth-day to you!`,
  },
  {
    id: 'jingle', level: 2, tags: ['christmas'], instrument: 'any',
    titles: { en: 'Jingle Bells', ms: 'Jingle Bells', 'zh-Hans': '铃儿响叮当', 'zh-Hant': '鈴兒響叮噹' },
    abc: `X:6
T:Jingle Bells
C:James Lord Pierpont
M:4/4
L:1/4
Q:1/4=120
K:G
"G"B B B2|B B B2|B d G3/2 A/|B4|
w:Jin-gle bells, jin-gle bells, jin-gle all the way!
"C"c c c3/2 c/|"G"c B B B/B/|"A7"B A A B|"D7"A2 d2|
w:Oh what fun it is to ride in a one-horse o-pen sleigh, hey!
"G"B B B2|B B B2|B d G3/2 A/|B4|
w:Jin-gle bells, jin-gle bells, jin-gle all the way!
"C"c c c c|"G"c B B B/B/|"D7"d d c A|"G"G4|]
w:Oh what fun it is to ride in a one-horse o-pen sleigh!`,
  },
  {
    id: 'silentnight', level: 2, tags: ['christmas'], instrument: 'any',
    titles: { en: 'Silent Night', ms: 'Malam Kudus', 'zh-Hans': '平安夜', 'zh-Hant': '平安夜' },
    abc: `X:7
T:Silent Night
C:Franz Xaver Gruber
M:6/8
L:1/8
Q:3/8=56
K:C
"C"G3/2A/G E3|G3/2A/G E3|"G"d2d B3|"C"c2c G3|
w:Si-_ lent night, ho-_ ly night, all is calm, all is bright,
"F"A2A c3/2B/A|"C"G3/2A/G E3|"F"A2A c3/2B/A|"C"G3/2A/G E3|
w:round yon vir-_ gin mo-ther and child, ho-ly in-fant so ten-der and mild,
"G7"d2d f3/2d/B|"C"c3 e3|"C"c G E "G7"G3/2F/D|"C"C6|]
w:sleep in hea-ven-ly peace,_ sleep in hea-ven-_ ly peace.`,
  },
  {
    id: 'auldlangsyne', level: 2, tags: ['celebration'], instrument: 'any',
    titles: { en: 'Auld Lang Syne', ms: 'Auld Lang Syne', 'zh-Hans': '友谊地久天长', 'zh-Hant': '友誼地久天長' },
    abc: `X:8
T:Auld Lang Syne
C:Traditional (words: Robert Burns)
M:4/4
L:1/4
Q:1/4=88
K:F
C|"F"F3/2 F/ F A|"C7"G3/2 F/ G A|"F"F3/2 F/ A c|"Bb"d3 d|
w:Should auld ac-quain-tance be for-got, and nev-er brought to mind? Should
"F"c3/2 A/ A F|"C7"G3/2 F/ G A|"Bb"F3/2 D/ "C7"D C|"F"F3|]
w:auld ac-quain-tance be for-got, and days of auld lang syne?`,
  },
  {
    id: 'amazinggrace', level: 2, tags: ['hymn'], instrument: 'any',
    titles: { en: 'Amazing Grace', ms: 'Amazing Grace', 'zh-Hans': '奇异恩典', 'zh-Hant': '奇異恩典' },
    abc: `X:9
T:Amazing Grace
C:Traditional (words: John Newton)
M:3/4
L:1/4
Q:1/4=80
K:G
D|"G"G2 B/G/|"G7"B2 A|"C"G2 E|"G"D2 D|
w:A-ma-zing_ grace, how sweet the sound that
"G"G2 B/G/|"Em"B2 A|"D"d3-|"D7"d2 B|
w:saved a_ wretch like me! I
"G"d2 B/G/|"G7"B2 A|"C"G2 E|"G"D2 D|
w:once was_ lost, but now am found, was
"Em"G2 B/G/|"D"B2 A|"G"G3-|"G"G2|]
w:blind, but_ now I see.`,
  },
  {
    id: 'canon', level: 2, tags: ['classical', 'wedding'], instrument: 'any',
    titles: { en: 'Canon in D (theme)', ms: 'Canon dalam D (tema)', 'zh-Hans': 'D大调卡农（主题）', 'zh-Hant': 'D大調卡農（主題）' },
    abc: `X:10
T:Canon in D (theme)
C:Johann Pachelbel
M:4/4
L:1/4
Q:1/4=60
K:D
|:"D"f2 "A"e2|"Bm"d2 "F#m"c2|"G"B2 "D"A2|"G"B2 "A"c2:|
"D"d4|]`,
  },
  {
    id: 'furelise', level: 3, tags: ['classical', 'piano'], instrument: 'piano',
    titles: { en: 'Für Elise (opening)', ms: 'Für Elise (pembukaan)', 'zh-Hans': '致爱丽丝（开头）', 'zh-Hant': '給愛麗絲（開頭）' },
    abc: `X:11
T:Für Elise (opening)
C:Ludwig van Beethoven
M:3/8
L:1/16
Q:1/8=120
K:Am
e^d|"E"e^de B=dc|"Am"A2 z CEA|"E"B2 z E^GB|"Am"c2 z Ee^d|
"E"e^de B=dc|"Am"A2 z CEA|"E"B2 z EcB|"Am"A6|]`,
  },
  {
    id: 'greensleeves', level: 3, tags: ['folk'], instrument: 'any',
    titles: { en: 'Greensleeves', ms: 'Greensleeves', 'zh-Hans': '绿袖子', 'zh-Hant': '綠袖子' },
    abc: `X:12
T:Greensleeves
C:Traditional
M:6/8
L:1/8
Q:3/8=60
K:Am
A|"Am"c2d e3/2f/e|"G"d2B G3/2A/B|"Am"c2A A3/2^G/A|"E"B2^G E2A|
"Am"c2d e3/2f/e|"G"d2B G3/2A/B|"Am"c3/2B/A "E"^G3/2^F/^G|"Am"A3 A2|]`,
  },
];

export function songTitle(song, lang) {
  return song.titles[lang] || song.titles.en;
}
