// Teaching Academy: courses, lessons and quiz generators. Text is [English, Malay, Simplified, Traditional].
import { rng } from './improv.js';
import { STEPS, nameOf, transposeName, iv, majorTonic, keyName, midiOf, spellMidi, mod } from './pitch.js';
import { parseChord, formatChord, chordNotes, diatonicChords, transposeChord, pianoVoicing } from './chords.js';

export const COURSES = [
  {
    id: 'read', color: 'blue', icon: 'staff',
    title: ['Read Music', 'Membaca Muzik', '识谱', '識譜'],
    blurb: ['Staff, clefs, note lengths and key signatures.', 'Baluk, klef, nilai not dan tanda kunci.', '五线谱、谱号、音符时值与调号。', '五線譜、譜號、音符時值與調號。'],
    lessons: [
      {
        id: 'read1', title: ['The treble clef', 'Klef trebel', '高音谱号', '高音譜號'],
        cards: [
          ['Music is written on five lines called the staff. Higher on the staff means higher in pitch.', 'Muzik ditulis pada lima garisan yang dipanggil baluk. Lebih tinggi pada baluk bermaksud nada lebih tinggi.', '音乐写在五条线上，叫五线谱。位置越高，音越高。', '音樂寫在五條線上，叫五線譜。位置越高，音越高。'],
          ['The treble clef curls around the second line from the bottom. That line is G.', 'Klef trebel berpusing pada garisan kedua dari bawah. Garisan itu ialah G.', '高音谱号的中心绕着从下往上第二线，那条线是 G。', '高音譜號的中心繞著從下往上第二線，那條線是 G。'],
          ['Lines from the bottom: E G B D F — "Every Good Boy Does Fine". Spaces spell F A C E.', 'Garisan dari bawah: E G B D F. Ruang membentuk F A C E.', '从下往上的线：E G B D F；间：F A C E。', '從下往上的線：E G B D F；間：F A C E。'],
        ],
        quiz: { type: 'noteName', clef: 'G', lo: 'E4', hi: 'F5', count: 8 },
      },
      {
        id: 'read2', title: ['The bass clef', 'Klef bes', '低音谱号', '低音譜號'],
        cards: [
          ['The bass clef is for low notes: cello, bass guitar and the piano left hand. Its two dots surround the F line.', 'Klef bes untuk not rendah: selo, gitar bes dan tangan kiri piano. Dua titiknya mengapit garisan F.', '低音谱号用于低音：大提琴、贝斯和钢琴左手。两个点夹着 F 线。', '低音譜號用於低音：大提琴、貝斯和鋼琴左手。兩個點夾著 F 線。'],
          ['Lines from the bottom: G B D F A. Spaces: A C E G.', 'Garisan dari bawah: G B D F A. Ruang: A C E G.', '从下往上的线：G B D F A；间：A C E G。', '從下往上的線：G B D F A；間：A C E G。'],
        ],
        quiz: { type: 'noteName', clef: 'F', lo: 'G2', hi: 'A3', count: 8 },
      },
      {
        id: 'read3', title: ['Note lengths', 'Nilai not', '音符时值', '音符時值'],
        cards: [
          ['A whole note lasts 4 beats, a half note 2, a quarter note 1 and an eighth note half a beat.', 'Semibrif 4 detik, minim 2, krocet 1 dan kuaver setengah detik.', '全音符 4 拍，二分音符 2 拍，四分音符 1 拍，八分音符半拍。', '全音符 4 拍，二分音符 2 拍，四分音符 1 拍，八分音符半拍。'],
          ['A dot adds half the note\'s length: a dotted half note lasts 3 beats.', 'Titik menambah separuh nilai not: minim bertitik bernilai 3 detik.', '附点增加一半时值：附点二分音符是 3 拍。', '附點增加一半時值：附點二分音符是 3 拍。'],
        ],
        quiz: { type: 'beats', count: 8 },
      },
      {
        id: 'read4', title: ['Key signatures', 'Tanda kunci', '调号', '調號'],
        cards: [
          ['Sharps or flats at the start of every line apply to the whole piece.', 'Syap atau flet di awal setiap baris berkuat kuasa untuk seluruh lagu.', '每行开头的升号或降号适用于整首曲子。', '每行開頭的升號或降號適用於整首曲子。'],
          ['Sharps come in the order F C G D A E B; flats in the order B E A D G C F.', 'Syap mengikut urutan F C G D A E B; flet mengikut B E A D G C F.', '升号顺序 F C G D A E B；降号顺序 B E A D G C F。', '升號順序 F C G D A E B；降號順序 B E A D G C F。'],
          ['Trick: with sharps, the major key is one semitone above the last sharp. With flats, it is the second-last flat.', 'Petua: dengan syap, kunci major ialah satu semiton di atas syap terakhir. Dengan flet, ia flet kedua terakhir.', '诀窍：升号调的主音比最后一个升号高半音；降号调的主音是倒数第二个降号。', '訣竅：升號調的主音比最後一個升號高半音；降號調的主音是倒數第二個降號。'],
        ],
        quiz: { type: 'keySig', count: 8 },
      },
    ],
  },
  {
    id: 'rhythm', color: 'orange', icon: 'metronome',
    title: ['Rhythm', 'Ritma', '节奏', '節奏'],
    blurb: ['Keep the beat, eighth notes, syncopation and swing.', 'Kekalkan rentak, kuaver, sinkopasi dan swing.', '稳定节拍、八分音符、切分与摇摆。', '穩定節拍、八分音符、切分與搖擺。'],
    lessons: [
      {
        id: 'rhythm1', title: ['Feel the beat', 'Rasai rentak', '感受节拍', '感受節拍'],
        cards: [['Listen to four clicks, then tap the big button on every click. Haptune measures how close you are in milliseconds.', 'Dengar empat ketukan, kemudian tekan butang besar pada setiap ketukan. Haptune mengukur ketepatan anda dalam milisaat.', '先听四下，然后每拍点一次大按钮。Haptune 会以毫秒计算你的准确度。', '先聽四下，然後每拍點一次大按鈕。Haptune 會以毫秒計算你的準確度。']],
        activity: { type: 'tap', pattern: 'q q q q q q q q', tempo: 80 },
      },
      {
        id: 'rhythm2', title: ['Eighth notes', 'Kuaver', '八分音符', '八分音符'],
        cards: [['Two eighth notes share one beat. Count "1 and 2 and".', 'Dua kuaver berkongsi satu detik. Kira "1 dan 2 dan".', '两个八分音符共用一拍，数“1 嗒 2 嗒”。', '兩個八分音符共用一拍，數「1 嗒 2 嗒」。']],
        activity: { type: 'tap', pattern: 'q e e q q e e e e q', tempo: 72 },
      },
      {
        id: 'rhythm3', title: ['Syncopation', 'Sinkopasi', '切分音', '切分音'],
        cards: [['Notes that start between the beats make music groove. Keep counting the beat while you tap off it.', 'Not yang bermula di antara detik membuat muzik lebih rancak. Terus kira detik semasa anda menekan di luar detik.', '在拍子之间开始的音让音乐有律动。点击时心里继续数拍。', '在拍子之間開始的音讓音樂有律動。點擊時心裡繼續數拍。']],
        activity: { type: 'tap', pattern: 'e q e q q e q e q', tempo: 72 },
      },
      {
        id: 'rhythm4', title: ['Straight or swing?', 'Lurus atau swing?', '平均还是摇摆？', '平均還是搖擺？'],
        cards: [['Swing plays pairs of eighth notes long–short, like a heartbeat. Listen and decide.', 'Swing memainkan pasangan kuaver panjang–pendek, seperti degupan jantung. Dengar dan pilih.', '摇摆把两个八分音符奏成一长一短，像心跳。听一听再选择。', '搖擺把兩個八分音符奏成一長一短，像心跳。聽一聽再選擇。']],
        quiz: { type: 'swing', count: 6 },
      },
    ],
  },
  {
    id: 'ear', color: 'purple', icon: 'ear',
    title: ['Ear Training', 'Latihan Telinga', '练耳', '練耳'],
    blurb: ['Pitch direction, intervals, chord colours and progressions.', 'Arah nada, sela, warna kord dan progresi.', '音高方向、音程、和弦色彩与和弦进行。', '音高方向、音程、和弦色彩與和弦進行。'],
    lessons: [
      {
        id: 'ear1', title: ['Higher or lower?', 'Tinggi atau rendah?', '高还是低？', '高還是低？'],
        cards: [['You will hear two notes. Was the second one higher or lower?', 'Anda akan dengar dua not. Adakah not kedua lebih tinggi atau rendah?', '你会听到两个音。第二个音更高还是更低？', '你會聽到兩個音。第二個音更高還是更低？']],
        quiz: { type: 'direction', count: 8 },
      },
      {
        id: 'ear2', title: ['Intervals', 'Sela', '音程', '音程'],
        cards: [
          ['An interval is the distance between two notes. Songs help you remember them:', 'Sela ialah jarak antara dua not. Lagu membantu anda mengingatinya:', '音程是两个音的距离。用歌曲帮助记忆：', '音程是兩個音的距離。用歌曲幫助記憶：'],
          ['Major 2nd: "Happy Birth-day". Major 3rd: "Oh, when the saints". Perfect 4th: "A-ma-zing Grace". Perfect 5th: "Twin-kle, twin-kle". Octave: "Hap-py birth-day dear".', 'Major 2: "Happy Birth-day". Major 3: "Oh when the saints". Perfect 4: "A-ma-zing Grace". Perfect 5: "Twin-kle twin-kle". Oktaf: "Hap-py birth-day dear".', '大二度：“祝你生日”；大三度：“Oh when the saints”；纯四度：“奇异恩典”开头；纯五度：“一闪一闪”；八度：生日歌“祝你生日快”的高音。', '大二度：「祝你生日」；大三度：「Oh when the saints」；純四度：「奇異恩典」開頭；純五度：「一閃一閃」；八度：生日歌的高音。'],
        ],
        quiz: { type: 'interval', set: ['M2', 'M3', 'P4', 'P5', 'P8'], count: 8 },
      },
      {
        id: 'ear3', title: ['Major or minor?', 'Major atau minor?', '大调还是小调？', '大調還是小調？'],
        cards: [['Major chords sound bright; minor chords sound darker. Diminished sounds tense, augmented sounds dreamy.', 'Kord major terdengar ceria; minor lebih suram. Diminished tegang, augmented seperti mimpi.', '大三和弦明亮，小三和弦较暗；减和弦紧张，增和弦梦幻。', '大三和弦明亮，小三和弦較暗；減和弦緊張，增和弦夢幻。']],
        quiz: { type: 'quality', set: ['maj', 'min'], count: 8 },
      },
      {
        id: 'ear4', title: ['Hear the change', 'Dengar perubahan', '听和弦变化', '聽和弦變化'],
        cards: [['You will hear the home chord (I), then another chord. Was it IV or V? V wants to go home; IV feels like a step away.', 'Anda akan dengar kord asal (I), kemudian kord lain. IV atau V? V mahu kembali ke asal; IV terasa melangkah pergi.', '你会先听到主和弦 (I)，然后另一个和弦。是 IV 还是 V？V 想回家，IV 像走开一步。', '你會先聽到主和弦 (I)，然後另一個和弦。是 IV 還是 V？V 想回家，IV 像走開一步。']],
        quiz: { type: 'function', count: 6 },
      },
    ],
  },
  {
    id: 'harmony', color: 'green', icon: 'chords',
    title: ['Chords & Keys', 'Kord & Kunci', '和弦与调', '和弦與調'],
    blurb: ['Build chords, Roman numerals, famous progressions, changing key.', 'Bina kord, angka Roman, progresi terkenal, tukar kunci.', '构成和弦、级数、经典进行与转调。', '構成和弦、級數、經典進行與轉調。'],
    lessons: [
      {
        id: 'harm1', title: ['Build a triad', 'Bina triad', '构成三和弦', '構成三和弦'],
        cards: [['A triad stacks a root, a third and a fifth. Major = 4 + 3 semitones; minor = 3 + 4.', 'Triad menyusun root, ketiga dan kelima. Major = 4 + 3 semiton; minor = 3 + 4.', '三和弦由根音、三音、五音叠成。大三 = 4+3 个半音，小三 = 3+4。', '三和弦由根音、三音、五音疊成。大三 = 4+3 個半音，小三 = 3+4。']],
        quiz: { type: 'chordNotes', count: 6 },
      },
      {
        id: 'harm2', title: ['Roman numerals', 'Angka Roman', '和弦级数', '和弦級數'],
        cards: [['Each note of a major scale has its own chord: I ii iii IV V vi vii°. Capitals are major, small letters minor.', 'Setiap not skala major ada kordnya: I ii iii IV V vi vii°. Huruf besar major, huruf kecil minor.', '大调音阶每个音都有自己的和弦：I ii iii IV V vi vii°。大写为大三，小写为小三。', '大調音階每個音都有自己的和弦：I ii iii IV V vi vii°。大寫為大三，小寫為小三。']],
        quiz: { type: 'roman', count: 8 },
      },
      {
        id: 'harm3', title: ['Famous progressions', 'Progresi terkenal', '经典和弦进行', '經典和弦進行'],
        cards: [
          ['I–V–vi–IV powers thousands of pop songs. IV–V–iii–vi is the "royal road" of C-pop and J-pop. ii–V–I is the heart of jazz.', 'I–V–vi–IV menggerakkan ribuan lagu pop. IV–V–iii–vi ialah "jalan diraja" C-pop dan J-pop. ii–V–I ialah nadi jazz.', 'I–V–vi–IV 用在无数流行歌里；IV–V–iii–vi 是华语和日本流行乐的“王道进行”；ii–V–I 是爵士的核心。', 'I–V–vi–IV 用在無數流行歌裡；IV–V–iii–vi 是華語和日本流行樂的「王道進行」；ii–V–I 是爵士的核心。'],
        ],
        quiz: { type: 'progName', count: 6 },
      },
      {
        id: 'harm4', title: ['Change the key', 'Tukar kunci', '转调与移调', '轉調與移調'],
        cards: [['Moving a song up or down moves every note and chord by the same distance. The Key buttons in every piece do this exactly; a capo does it on guitar.', 'Menaikkan atau menurunkan lagu menggerakkan setiap not dan kord dengan jarak yang sama. Butang Kunci dalam setiap lagu melakukannya dengan tepat; kapo melakukannya pada gitar.', '升高或降低一首歌，就是把每个音和和弦移动同样的距离。每首曲子的“调”按钮会精确完成；吉他用变调夹。', '升高或降低一首歌，就是把每個音和和弦移動同樣的距離。每首曲子的「調」按鈕會精確完成；吉他用移調夾。']],
        quiz: { type: 'transpose', count: 8 },
      },
    ],
  },
  {
    id: 'improv', color: 'pink', icon: 'sparkles',
    title: ['Improvisation', 'Improvisasi', '即兴演奏', '即興演奏'],
    blurb: ['Pentatonic, chord tones, call and response, the blues.', 'Pentatonik, not kord, panggilan dan jawapan, blues.', '五声音阶、和弦音、问答句、蓝调。', '五聲音階、和弦音、問答句、藍調。'],
    lessons: [
      {
        id: 'imp1', title: ['The pentatonic scale', 'Skala pentatonik', '五声音阶', '五聲音階'],
        cards: [['Five notes that almost never clash: 1 2 3 5 6 of the major scale (do re mi so la). It is the sound of folk music across Asia.', 'Lima not yang hampir tidak bertembung: 1 2 3 5 6 skala major (do re mi so la). Bunyi muzik rakyat di seluruh Asia.', '五个几乎不会冲突的音：大调的 1 2 3 5 6（宫商角徵羽），是亚洲民乐的声音。', '五個幾乎不會衝突的音：大調的 1 2 3 5 6（宮商角徵羽），是亞洲民樂的聲音。']],
        quiz: { type: 'scaleNotes', scale: 'pentatonic', count: 5 },
        link: 'improvise',
      },
      {
        id: 'imp2', title: ['Land on chord tones', 'Mendarat pada not kord', '落在和弦音上', '落在和弦音上'],
        cards: [['On strong beats, play a note of the chord (root, 3rd, 5th, 7th). Between them, any scale note can walk you there.', 'Pada detik kuat, mainkan not kord (root, 3, 5, 7). Di antaranya, mana-mana not skala boleh membawa anda ke sana.', '强拍上演奏和弦音（根音、三音、五音、七音），中间用音阶音过渡。', '強拍上演奏和弦音（根音、三音、五音、七音），中間用音階音過渡。']],
        quiz: { type: 'chordTones', count: 6 },
        link: 'improvise',
      },
      {
        id: 'imp3', title: ['Call and response', 'Panggilan dan jawapan', '问答句', '問答句'],
        cards: [['Play a short idea, then answer it: same rhythm, different ending. The AI improviser builds every solo this way.', 'Mainkan idea pendek, kemudian jawab: ritma sama, pengakhiran berbeza. Pemain improvisasi AI membina setiap solo begini.', '先奏一个短乐句，再回答它：节奏相同，结尾不同。AI 即兴就是这样构建每段独奏的。', '先奏一個短樂句，再回答它：節奏相同，結尾不同。AI 即興就是這樣構建每段獨奏的。']],
        link: 'improvise',
      },
      {
        id: 'imp4', title: ['The blues scale', 'Skala blues', '蓝调音阶', '藍調音階'],
        cards: [['1 ♭3 4 ♭5 5 ♭7 — the "blue note" ♭5 adds the cry of the blues. Try it over a 12-bar blues.', '1 ♭3 4 ♭5 5 ♭7 — "not biru" ♭5 menambah rasa blues. Cuba atas blues 12 bar.', '1 ♭3 4 ♭5 5 ♭7——“蓝音”♭5 带来蓝调的味道。在 12 小节蓝调上试试。', '1 ♭3 4 ♭5 5 ♭7——「藍音」♭5 帶來藍調的味道。在 12 小節藍調上試試。']],
        quiz: { type: 'scaleNotes', scale: 'blues', count: 5 },
        link: 'improvise',
      },
    ],
  },
  {
    id: 'labs', color: 'teal', icon: 'tuningfork',
    title: ['Instrument Labs', 'Makmal Alat Muzik', '乐器实验室', '樂器實驗室'],
    blurb: ['Tuning, your voice range, intonation and keyboard basics.', 'Penalaan, julat suara, intonasi dan asas papan kekunci.', '调音、你的音域、音准与键盘基础。', '調音、你的音域、音準與鍵盤基礎。'],
    lessons: [
      {
        id: 'lab1', title: ['Tune up', 'Tala alat', '调音', '調音'],
        cards: [['Violin strings are G D A E, guitar E A D G B E, ukulele G C E A. Play the reference notes and match them, or use the tuner.', 'Tali biola G D A E, gitar E A D G B E, ukulele G C E A. Mainkan not rujukan dan padankan, atau guna penala.', '小提琴弦 G D A E，吉他 E A D G B E，尤克里里 G C E A。播放标准音来对音，或使用调音器。', '小提琴弦 G D A E，吉他 E A D G B E，烏克麗麗 G C E A。播放標準音來對音，或使用調音器。']],
        activity: { type: 'strings' },
      },
      {
        id: 'lab2', title: ['Your voice range', 'Julat suara anda', '你的音域', '你的音域'],
        cards: [['Choose your voice type, or sing your lowest and highest comfortable notes. "Find my key" uses it to move any song into your range.', 'Pilih jenis suara anda, atau nyanyikan not terendah dan tertinggi yang selesa. "Cari kunci saya" menggunakannya untuk menyesuaikan lagu dengan julat anda.', '选择你的声部，或唱出最舒服的最低和最高音。“找我的调”会据此把歌曲移到适合你的调。', '選擇你的聲部，或唱出最舒服的最低和最高音。「找我的調」會據此把歌曲移到適合你的調。']],
        activity: { type: 'voiceRange' },
      },
      {
        id: 'lab3', title: ['Intonation drill', 'Latihan intonasi', '音准练习', '音準練習'],
        cards: [['A steady drone plays the home note. Play or sing the scale slowly and listen for beats (wobbles) that mean you are out of tune.', 'Dron yang stabil memainkan not asal. Mainkan atau nyanyikan skala perlahan-lahan dan dengar "getaran" yang bermaksud anda tidak tepat.', '持续音播放主音。慢慢演奏或唱音阶，注意“拍音”（颤动），那表示音不准。', '持續音播放主音。慢慢演奏或唱音階，注意「拍音」（顫動），那表示音不準。']],
        activity: { type: 'drone' },
      },
      {
        id: 'lab4', title: ['Keyboard map', 'Peta papan kekunci', '键盘地图', '鍵盤地圖'],
        cards: [['C is the white key left of the two black keys. Find any note by counting up the alphabet from C.', 'C ialah kekunci putih di kiri dua kekunci hitam. Cari mana-mana not dengan mengira abjad dari C.', 'C 是两个黑键左边的白键。从 C 往上数字母就能找到任何音。', 'C 是兩個黑鍵左邊的白鍵。從 C 往上數字母就能找到任何音。']],
        quiz: { type: 'keyboard', count: 8 },
      },
    ],
  },
];

export const LANG_INDEX = { en: 0, ms: 1, 'zh-Hans': 2, 'zh-Hant': 3 };
export const tx = (arr, lang) => (Array.isArray(arr) ? arr[LANG_INDEX[lang] ?? 0] ?? arr[0] : arr);

export function findLesson(id) {
  for (const c of COURSES) for (const l of c.lessons) if (l.id === id) return { course: c, lesson: l };
  return null;
}

export function allLessons() { return COURSES.flatMap((c) => c.lessons.map((l) => ({ course: c, lesson: l }))); }

// ---------- quiz generation ----------

const parseP = (s) => {
  const m = /^([A-G])(\d)$/.exec(s);
  return { step: m[1], alter: 0, octave: Number(m[2]) };
};
const diatonicIndex = (p) => p.octave * 7 + STEPS.indexOf(p.step);
const fromIndex = (i) => ({ step: STEPS[mod(i, 7)], alter: 0, octave: Math.floor(i / 7) });

function shuffle(arr, r) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** Questions for a lesson quiz: [{kind, prompt key, data, options:[{id,label}], answer}] */
export function makeQuiz(spec, seed = Date.now() % 100000) {
  const r = rng(seed);
  const out = [];
  for (let k = 0; k < (spec.count || 8); k++) out.push(question(spec, r, k));
  return out;
}

const INTERVAL_SEMIS = { m2: 1, M2: 2, m3: 3, M3: 4, P4: 5, TT: 6, P5: 7, m6: 8, M6: 9, m7: 10, M7: 11, P8: 12 };
export const INTERVAL_NAMES = {
  m2: ['minor 2nd', 'minor 2', '小二度', '小二度'], M2: ['major 2nd', 'major 2', '大二度', '大二度'], m3: ['minor 3rd', 'minor 3', '小三度', '小三度'],
  M3: ['major 3rd', 'major 3', '大三度', '大三度'], P4: ['perfect 4th', 'perfect 4', '纯四度', '純四度'], TT: ['tritone', 'tritone', '三全音', '三全音'],
  P5: ['perfect 5th', 'perfect 5', '纯五度', '純五度'], m6: ['minor 6th', 'minor 6', '小六度', '小六度'], M6: ['major 6th', 'major 6', '大六度', '大六度'],
  m7: ['minor 7th', 'minor 7', '小七度', '小七度'], M7: ['major 7th', 'major 7', '大七度', '大七度'], P8: ['octave', 'oktaf', '八度', '八度'],
};

function question(spec, r, k) {
  switch (spec.type) {
    case 'noteName': {
      const lo = diatonicIndex(parseP(spec.lo)), hi = diatonicIndex(parseP(spec.hi));
      const p = fromIndex(lo + Math.floor(r() * (hi - lo + 1)));
      const options = ['C', 'D', 'E', 'F', 'G', 'A', 'B'].map((s) => ({ id: s, label: s }));
      return { kind: 'noteName', staff: { clef: spec.clef, notes: [p] }, play: [midiOf(p)], options, answer: p.step };
    }
    case 'beats': {
      const items = [['whole', 0, '4'], ['half', 0, '2'], ['quarter', 0, '1'], ['eighth', 0, '½'], ['half', 1, '3'], ['quarter', 1, '1½']];
      const [type, dots, ans] = items[Math.floor(r() * items.length)];
      const options = ['½', '1', '1½', '2', '3', '4'].map((s) => ({ id: s, label: s }));
      return { kind: 'beats', staff: { clef: 'G', rhythm: [{ type, dots }] }, options, answer: ans };
    }
    case 'keySig': {
      const f = [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5][Math.floor(r() * 10)];
      const ans = nameOf(majorTonic(f));
      const pool = new Set([ans]);
      while (pool.size < 4) pool.add(nameOf(majorTonic([-4, -3, -2, -1, 0, 1, 2, 3, 4, 5][Math.floor(r() * 10)])));
      return { kind: 'keySig', staff: { clef: 'G', keySig: f }, options: shuffle([...pool], r).map((s) => ({ id: s, label: s })), answer: ans };
    }
    case 'swing': {
      const swing = r() < 0.5;
      return { kind: 'swing', play: { pattern: 'swing', swing }, options: [{ id: 'straight', label: 'straight' }, { id: 'swing', label: 'swing' }], answer: swing ? 'swing' : 'straight' };
    }
    case 'direction': {
      const a = 55 + Math.floor(r() * 18);
      let b = a + (r() < 0.5 ? -1 : 1) * (1 + Math.floor(r() * 7));
      if (b === a) b = a + 2;
      return { kind: 'direction', play: [a, b], options: [{ id: 'up', label: 'higher' }, { id: 'down', label: 'lower' }], answer: b > a ? 'up' : 'down' };
    }
    case 'interval': {
      const name = spec.set[Math.floor(r() * spec.set.length)];
      const a = 55 + Math.floor(r() * 10);
      return { kind: 'interval', play: [a, a + INTERVAL_SEMIS[name]], options: spec.set.map((s) => ({ id: s, label: s })), answer: name };
    }
    case 'quality': {
      const qy = spec.set[Math.floor(r() * spec.set.length)];
      const root = { step: STEPS[Math.floor(r() * 7)], alter: 0 };
      return { kind: 'quality', play: { chord: pianoVoicing({ root, quality: qy }, 4) }, options: spec.set.map((s) => ({ id: s, label: s })), answer: qy };
    }
    case 'function': {
      const keyF = [-2, -1, 0, 1, 2][Math.floor(r() * 5)];
      const dia = diatonicChords({ fifths: keyF, mode: 'major' });
      const which = r() < 0.5 ? 3 : 4;
      return { kind: 'function', play: { chords: [pianoVoicing(dia[0], 4), pianoVoicing(dia[which], 4)] }, options: [{ id: 'IV', label: 'IV' }, { id: 'V', label: 'V' }], answer: which === 3 ? 'IV' : 'V' };
    }
    case 'chordNotes': {
      const roots = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'Bb', 'Eb'];
      const root = roots[Math.floor(r() * roots.length)];
      const qy = r() < 0.5 ? 'maj' : 'min';
      const c = parseChord(root + (qy === 'min' ? 'm' : ''));
      const right = chordNotes(c).map((n) => nameOf(n)).join(' ');
      const other = chordNotes({ ...c, quality: qy === 'maj' ? 'min' : 'maj' }).map((n) => nameOf(n)).join(' ');
      const wrong2 = chordNotes({ ...c, quality: 'sus4' }).map((n) => nameOf(n)).join(' ');
      const wrong3 = chordNotes({ ...c, quality: 'aug' }).map((n) => nameOf(n)).join(' ');
      return { kind: 'chordNotes', chord: formatChord(c), play: { chord: pianoVoicing(c, 4) }, options: shuffle([right, other, wrong2, wrong3], r).map((s) => ({ id: s, label: s })), answer: right };
    }
    case 'roman': {
      const keyF = [-3, -2, -1, 0, 1, 2, 3][Math.floor(r() * 7)];
      const key = { fifths: keyF, mode: 'major' };
      const dia = diatonicChords(key);
      const deg = [0, 1, 3, 4, 5][Math.floor(r() * 5)];
      const numerals = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
      const ans = formatChord(dia[deg]);
      const pool = new Set([ans]);
      while (pool.size < 4) pool.add(formatChord(dia[Math.floor(r() * 7)]));
      return { kind: 'roman', key: keyName(key), numeral: numerals[deg], options: shuffle([...pool], r).map((s) => ({ id: s, label: s })), answer: ans };
    }
    case 'progName': {
      const progs = [['I–V–vi–IV', [0, 4, 5, 3]], ['IV–V–iii–vi', [3, 4, 2, 5]], ['ii–V–I', [1, 4, 0]], ['I–vi–IV–V', [0, 5, 3, 4]]];
      const keyF = [-1, 0, 1, 2][Math.floor(r() * 4)];
      const dia = diatonicChords({ fifths: keyF, mode: 'major' });
      const [name, degs] = progs[Math.floor(r() * progs.length)];
      const chords = degs.map((d) => formatChord(dia[d])).join(' – ');
      return { kind: 'progName', key: keyName({ fifths: keyF, mode: 'major' }), chords, play: { chords: degs.map((d) => pianoVoicing(dia[d], 4)) }, options: progs.map(([n]) => ({ id: n, label: n })), answer: name };
    }
    case 'transpose': {
      const roots = ['C', 'D', 'E', 'F', 'G', 'A', 'Bb', 'Am', 'Em', 'Dm'];
      const c = parseChord(roots[Math.floor(r() * roots.length)]);
      const semis = [1, 2, 3, 5, 7, -2][Math.floor(r() * 6)];
      const table = { 1: iv(1, 1), 2: iv(1, 2), 3: iv(2, 3), 5: iv(3, 5), 7: iv(4, 7), '-2': iv(-1, -2) };
      const ans = formatChord(transposeChord(c, table[semis]));
      const pool = new Set([ans]);
      for (const s of [1, 2, 3, 4, 5, 7, -1, -2]) { if (pool.size >= 4) break; const x = formatChord(transposeChord(c, { d: Math.round(s * 7 / 12), c: s })); pool.add(x); }
      return { kind: 'transpose', chord: formatChord(c), semis, options: shuffle([...pool].slice(0, 4), r).map((s) => ({ id: s, label: s })), answer: ans };
    }
    case 'scaleNotes': {
      const tonics = ['C', 'G', 'D', 'A', 'F'];
      const t = { step: tonics[Math.floor(r() * tonics.length)], alter: 0 };
      const sets = {
        pentatonic: [iv(0, 0), iv(1, 2), iv(2, 4), iv(4, 7), iv(5, 9)],
        blues: [iv(0, 0), iv(2, 3), iv(3, 5), iv(4, 6), iv(4, 7), iv(6, 10)],
        major: [iv(0, 0), iv(1, 2), iv(2, 4), iv(3, 5), iv(4, 7), iv(5, 9), iv(6, 11)],
        minorpent: [iv(0, 0), iv(2, 3), iv(3, 5), iv(4, 7), iv(6, 10)],
      };
      const fmt = (ivs) => ivs.map((x) => nameOf(transposeName(t, x))).join(' ');
      const right = fmt(sets[spec.scale]);
      const others = Object.keys(sets).filter((s) => s !== spec.scale).map((s) => fmt(sets[s]));
      return { kind: 'scaleNotes', scale: spec.scale, tonic: nameOf(t), options: shuffle([right, ...others.slice(0, 3)], r).map((s) => ({ id: s, label: s })), answer: right };
    }
    case 'chordTones': {
      const names = ['Am7', 'Dm7', 'G7', 'Cmaj7', 'Em7', 'Fmaj7', 'D7', 'Bm7'];
      const c = parseChord(names[Math.floor(r() * names.length)]);
      const right = chordNotes(c).map((n) => nameOf(n)).join(' ');
      const wrongs = [{ ...c, quality: c.quality === 'm7' ? 'maj7' : 'm7' }, { ...c, quality: c.quality === '7' ? 'maj7' : '7' }, { ...c, quality: 'm7b5' }]
        .map((x) => chordNotes(x).map((n) => nameOf(n)).join(' ')).filter((x) => x !== right);
      const opts = [...new Set([right, ...wrongs])].slice(0, 4);
      return { kind: 'chordTones', chord: formatChord(c), options: shuffle(opts, r).map((s) => ({ id: s, label: s })), answer: right };
    }
    case 'keyboard': {
      const midi = 60 + Math.floor(r() * 12);
      const n = spellMidi(midi, r() < 0.5 ? 1 : -1);
      const ans = nameOf(n);
      const pool = new Set([ans]);
      while (pool.size < 4) pool.add(nameOf(spellMidi(60 + Math.floor(r() * 12), r() < 0.5 ? 1 : -1)));
      return { kind: 'keyboard', highlight: midi, options: shuffle([...pool], r).map((s) => ({ id: s, label: s })), answer: ans };
    }
    default: return { kind: 'none', options: [], answer: null };
  }
}

// ---------- XP, levels, badges, challenge codes ----------

export function levelFor(xp) {
  let level = 1, need = 100, left = xp;
  while (left >= need) { left -= need; level++; need = Math.round(need * 1.25); }
  return { level, into: left, need };
}

export const BADGES = [
  { id: 'first', icon: 'star', title: ['First lesson', 'Pelajaran pertama', '第一课', '第一課'] },
  { id: 'perfect', icon: 'trophy', title: ['Perfect quiz', 'Kuiz sempurna', '满分测验', '滿分測驗'] },
  { id: 'streak3', icon: 'flame', title: ['3-day streak', '3 hari berturut', '连续 3 天', '連續 3 天'] },
  { id: 'streak7', icon: 'flame', title: ['7-day streak', '7 hari berturut', '连续 7 天', '連續 7 天'] },
  { id: 'ear', icon: 'ear', title: ['Golden ear', 'Telinga emas', '金耳朵', '金耳朵'] },
  { id: 'transposer', icon: 'arrows', title: ['Key changer', 'Penukar kunci', '转调高手', '轉調高手'] },
  { id: 'improviser', icon: 'sparkles', title: ['Improviser', 'Pemain improvisasi', '即兴达人', '即興達人'] },
  { id: 'collector', icon: 'books', title: ['10 pieces', '10 lagu', '收藏 10 首', '收藏 10 首'] },
  { id: 'challenger', icon: 'flag', title: ['Challenger', 'Pencabar', '挑战者', '挑戰者'] },
];

const B36 = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Challenge code: lesson index, seed, score, seconds, initials -> "HT-3F-7KQ2-8-42-AT" style (no server needed). */
export function makeChallengeCode({ lessonId, seed, score, seconds, initials = '' }) {
  const idx = allLessons().findIndex((x) => x.lesson.id === lessonId);
  const enc = (n, len) => { let s = ''; let v = Math.max(0, Math.floor(n)); do { s = B36[v % B36.length] + s; v = Math.floor(v / B36.length); } while (v > 0); return s.padStart(len, '0'); };
  const body = `${enc(idx, 2)}${enc(seed % 1000000, 4)}${enc(score, 1)}${enc(Math.min(seconds, 1100), 2)}`;
  const check = B36[[...body].reduce((s, ch) => s + B36.indexOf(ch) * 7, 0) % B36.length];
  return `HT-${body.slice(0, 2)}${body.slice(2, 6)}-${body.slice(6)}${check}${initials ? '-' + initials.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) : ''}`;
}

export function readChallengeCode(code) {
  const m = /^HT-([0-9A-Z]{2})([0-9A-Z]{4})-([0-9A-Z])([0-9A-Z]{2})([0-9A-Z])(?:-([A-Z]{1,3}))?$/.exec(String(code).trim().toUpperCase());
  if (!m) return null;
  const dec = (s) => [...s].reduce((v, ch) => v * B36.length + B36.indexOf(ch), 0);
  const body = m[1] + m[2] + m[3] + m[4];
  const check = B36[[...body].reduce((s, ch) => s + B36.indexOf(ch) * 7, 0) % B36.length];
  if (check !== m[5]) return null;
  const lessons = allLessons();
  const l = lessons[dec(m[1])];
  if (!l) return null;
  return { lessonId: l.lesson.id, seed: dec(m[2]), score: dec(m[3]), seconds: dec(m[4]), initials: m[6] || '' };
}
