import XCTest
@testable import PracticeCore

final class PracticeCoreTests: XCTestCase {

    private func fixture(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures"))
    }

    // MARK: score loading

    func testDecodesEngineJSON() throws {
        let s = try PracticeScore.decode(Data(contentsOf: fixture("minuet.json")))
        XCTAssertEqual(s.notes.count, 64)
        XCTAssertEqual(s.measures.count, 16)
        XCTAssertEqual(s.measures[0].timeSignature, [3, 4])
        XCTAssertEqual(s.notes.first?.pitch, 74)
        XCTAssertEqual(s.beatToSeconds(3), 3 * 60 / 96, accuracy: 1e-9)
        let again = try PracticeScore.decode(s.encoded())
        XCTAssertEqual(again.notes, s.notes)
    }

    func testParsesMusicXMLLikeTheEngine() throws {
        let s = try MusicXMLParser.load(url: fixture("minuet.musicxml"))
        XCTAssertEqual(s.notes.count, 64)
        XCTAssertEqual(s.measures.count, 16)
        XCTAssertEqual(s.notes.prefix(6).map { $0.pitch }, [74, 67, 69, 71, 72, 74])
        XCTAssertEqual(s.parts.first?.instrument, "violin")
        XCTAssertEqual(s.measures[1].keyFifths, 1)
    }

    func testRepeatsAndEndings() throws {
        let xml = """
        <?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
        <part id="P1">
        <measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
         <barline location="left"><repeat direction="forward"/></barline>
         <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration></note></measure>
        <measure number="2"><barline location="left"><ending number="1" type="start"/></barline>
         <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration></note>
         <barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>
        <measure number="3"><barline location="left"><ending number="2" type="start"/></barline>
         <note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration></note>
         <barline location="right"><ending number="2" type="discontinue"/></barline></measure>
        <measure number="4"><note><pitch><step>F</step><octave>5</octave></pitch><duration>2</duration></note></measure>
        </part></score-partwise>
        """
        let s = try MusicXMLParser.parse(data: Data(xml.utf8))
        XCTAssertEqual(s.notes.map { $0.pitch }, [72, 74, 72, 76, 77])
        XCTAssertEqual(s.measures.map { $0.label }, ["1", "2", "1", "3", "4"])
    }

    func testTransposingInstrument() throws {
        let xml = """
        <?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Clarinet in B-flat</part-name></score-part></part-list>
        <part id="P1"><measure number="1"><attributes><divisions>1</divisions>
        <transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>
        <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note></measure></part></score-partwise>
        """
        let s = try MusicXMLParser.parse(data: Data(xml.utf8))
        XCTAssertEqual(s.notes[0].written, 74)
        XCTAssertEqual(s.notes[0].pitch, 72)
        XCTAssertEqual(s.parts[0].instrument, "clarinet")
    }

    func testJianpu() throws {
        let s = try Jianpu.parse("key: 1=F\ntime: 2/4\ntempo: 72\n---\n3 3_5_ | 6_1'_1'_6_ | 5 - |")
        XCTAssertEqual(s.notes.map { $0.pitch! }, [69, 69, 72, 74, 77, 77, 74, 72])
        XCTAssertEqual(s.notes.last?.duration, 2)
        XCTAssertEqual(s.measures.count, 3)
    }

    func testMIDIFile() throws {
        // format 0, 96 ticks per quarter note, 120 BPM: C4 D4 E4 as quarter notes
        var bytes: [UInt8] = Array("MThd".utf8) + [0, 0, 0, 6, 0, 0, 0, 1, 0, 96]
        var track: [UInt8] = [0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20]
        for p in [60, 62, 64] {
            track += [0x00, 0x90, UInt8(p), 100, 0x60, 0x80, UInt8(p), 0]
        }
        track += [0x00, 0xFF, 0x2F, 0x00]
        bytes += Array("MTrk".utf8) + [0, 0, 0, UInt8(track.count)] + track
        let s = try MIDIFile.parse(data: Data(bytes), fallbackTitle: "Scale")
        XCTAssertEqual(s.notes.map { $0.pitch }, [60, 62, 64])
        XCTAssertEqual(s.notes.map { $0.onset }, [0, 1, 2])
        XCTAssertEqual(s.firstTempo, 120, accuracy: 0.01)
        XCTAssertEqual(s.measures.count, 1)
        XCTAssertEqual(s.title, "Scale")
        XCTAssertEqual(s.parts.first?.id, "P1")
    }

    func testInstrumentsLoad() {
        XCTAssertGreaterThan(InstrumentLibrary.all.count, 20)
        XCTAssertEqual(InstrumentLibrary.profile("violin").openStrings, [55, 62, 69, 76])
        XCTAssertEqual(InstrumentLibrary.profile("clarinet").transpose, -2)
        XCTAssertNotNil(HapticSpec.table[.wrongNote])
    }

    // MARK: DSP

    static func tone(midi: Double, seconds: Double, harmonics: Int = 6, sr: Double = DSP.sampleRate) -> [Float] {
        let f0 = Pitch.hz(midi: midi)
        let n = Int(seconds * sr)
        return (0..<n).map { i in
            let t = Double(i) / sr
            var v = 0.0
            for h in 1...harmonics { v += sin(2 * .pi * f0 * Double(h) * t) / Double(h) }
            let env = min(1, t / 0.03) * min(1, max(0, seconds - t) / 0.03)
            return Float(0.3 * v * env)
        }
    }

    func testFFTMatchesKnownSpectrum() {
        let fft = DSP.FFT(size: 1024)
        let x = (0..<1024).map { sin(2 * .pi * 64 * Double($0) / 1024) }
        let mag = fft.magnitude(x)
        XCTAssertEqual(mag.indices.max(by: { mag[$0] < mag[$1] }), 64)
        XCTAssertEqual(mag[64], 512, accuracy: 1e-6)
    }

    func testYINAccuracy() {
        for (inst, midi) in [("violin", 69.0), ("cello", 43.0), ("voice_soprano", 72.0), ("flute", 84.0)] {
            let p = InstrumentLibrary.profile(inst)
            let yin = DSP.YIN(fMin: p.fMin, fMax: p.fMax)
            let x = Self.tone(midi: midi, seconds: 0.5).map(Double.init)
            let r = yin.analyse(Array(x[2000..<(2000 + yin.windowLength)]))
            XCTAssertEqual(Pitch.midi(hz: r.hz), midi, accuracy: 0.05, inst)
            XCTAssertLessThan(r.cmnd, 0.1)
        }
    }

    // MARK: follower

    func testFollowerBuzzesOnWrongNoteOnly() throws {
        // C5 D5 E5 F5 G5 (quarter notes at 100 BPM); the player plays F#5 instead of F5
        let pitches = [72, 74, 76, 77, 79]
        let notes = pitches.enumerated().map { PracticeScore.Note(id: "n\($0.offset)", part: "P1", measure: 0,
                                                                   onset: Double($0.offset), duration: 1, pitch: $0.element) }
        let score = PracticeScore(title: "t", parts: [.init(id: "P1", instrument: "flute")],
                                  measures: [.init(index: 0, label: "1", start: 0, duration: 5, timeSignature: [5, 4])],
                                  tempos: [[0, 100]], notes: notes)
        let f = ScoreFollower(score: score, instrument: InstrumentLibrary.profile("flute"))
        var audio = [Float](repeating: 0, count: 4000)
        for (i, p) in pitches.enumerated() {
            audio += Self.tone(midi: Double(i == 3 ? 78 : p), seconds: 0.58)
            audio += [Float](repeating: 0, count: 300)
        }
        audio += [Float](repeating: 0, count: 8000)
        var events: [FeedbackEvent] = []
        var i = 0
        while i < audio.count { events += f.push(Array(audio[i..<min(audio.count, i + 512)])); i += 512 }
        let wrong = events.filter { $0.kind == .wrongNote }
        XCTAssertEqual(wrong.count, 1)
        XCTAssertEqual(wrong.first?.expected, 77)
        XCTAssertEqual(wrong.first?.played, 78)
        XCTAssertTrue(f.isFinished)
        XCTAssertEqual(f.summary().correct, 4)
    }
}
