import PracticeCore
import SwiftUI

@main
struct HaptuneWatchApp: App {
    @StateObject private var coach = WatchCoach()
    var body: some Scene {
        WindowGroup {
            TabView {
                CoachView()
                MetronomeView(metronome: coach.metronome)
                LastTakeView()
            }
            .tabViewStyle(.verticalPage)
            .environmentObject(coach)
            .onAppear { coach.activate() }
        }
    }
}

/// Like a Workout screen: what to play next, and a big coloured sign the moment something is off.
struct CoachView: View {
    @EnvironmentObject var coach: WatchCoach

    private var tint: Color {
        switch coach.lastKind {
        case .wrongNote: return .red
        case .missedNote: return .orange
        case .sharp, .flat: return .purple
        case .rushing, .dragging: return .yellow
        case .sectionClean: return .green
        default: return .accentColor
        }
    }

    var body: some View {
        VStack(spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("Bar \(coach.bar)").font(.system(.title3, design: .rounded).weight(.semibold)).monospacedDigit()
                Spacer()
                if !coach.expected.isEmpty {
                    Text(verbatim: coach.expected).font(.system(.title3, design: .rounded)).foregroundStyle(.secondary)
                }
            }
            ZStack {
                Circle().stroke(tint.opacity(0.25), lineWidth: 6)
                Circle().trim(from: 0, to: coach.running ? 1 : 0).stroke(tint, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Image(systemName: coach.glyph)
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(tint)
                    .contentTransition(.symbolEffect(.replace))
            }
            .frame(width: 78, height: 78)
            .animation(.easeOut(duration: 0.2), value: coach.lastKind)
            Text(coach.message).font(.footnote).multilineTextAlignment(.center).lineLimit(2).minimumScaleFactor(0.8)
            Button {
                coach.send(coach.running ? .stop : .start)
            } label: {
                if coach.running {
                    Label("Stop", systemImage: "stop.fill")
                } else {
                    Label("Start", systemImage: "play.fill")
                }
            }
            .tint(coach.running ? .red : .green)
        }
        .padding(.horizontal, 4)
        .navigationTitle(coach.title)
        .containerBackground(tint.gradient.opacity(0.25), for: .navigation)
    }
}

/// Stand-alone haptic metronome (works without the phone). Turn the Digital Crown to set the tempo.
struct MetronomeView: View {
    @ObservedObject var metronome: HapticMetronome
    @State private var bpm = 80.0
    @State private var beats = 4

    var body: some View {
        VStack(spacing: 8) {
            Text(verbatim: "\(Int(bpm))")
                .font(.system(size: 50, weight: .bold, design: .rounded).monospacedDigit())
                .focusable()
                .digitalCrownRotation($bpm, from: 30, through: 220, by: 1, sensitivity: .medium, isContinuous: false)
            Text("BPM · \(beats) beats").font(.footnote).foregroundStyle(.secondary)
            HStack {
                Button { beats = max(2, beats - 1) } label: { Image(systemName: "minus") }
                Button {
                    if metronome.running { metronome.stop() } else { metronome.start(bpm: bpm, beatsPerBar: beats) }
                } label: {
                    Image(systemName: metronome.running ? "stop.fill" : "play.fill")
                }
                .tint(metronome.running ? .red : .green)
                Button { beats = min(7, beats + 1) } label: { Image(systemName: "plus") }
            }
        }
        .navigationTitle("Metronome")
    }
}

/// The last take's result, sent by the iPhone when a take ends.
struct LastTakeView: View {
    @EnvironmentObject var coach: WatchCoach

    var body: some View {
        VStack(spacing: 8) {
            if let s = coach.summary, s.total > 0 {
                let pct = Double(s.correct) / Double(s.total)
                Gauge(value: pct) {
                    Text("Correct")
                } currentValueLabel: {
                    Text(verbatim: "\(Int((pct * 100).rounded()))")
                }
                .gaugeStyle(.accessoryCircular)
                .tint(Gradient(colors: [.red, .orange, .green]))
                .scaleEffect(1.4)
                .padding(.bottom, 8)
                HStack(spacing: 14) {
                    VStack { Text(verbatim: "\(s.wrong)").font(.headline); Text("wrong").font(.caption2).foregroundStyle(.secondary) }
                    VStack { Text(verbatim: "\(s.missed)").font(.headline); Text("missed").font(.caption2).foregroundStyle(.secondary) }
                }
            } else {
                Image(systemName: "chart.bar.fill").font(.largeTitle).foregroundStyle(.secondary)
                Text("Your last take will appear here.").font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Last Take")
    }
}
