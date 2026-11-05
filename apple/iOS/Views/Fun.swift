import SwiftUI

/// Soft colour blobs drifting slowly behind the content, like the web app's background.
struct HaptuneBackground: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            ZStack {
                base
                blob(Color(red: 0.55, green: 0.40, blue: 1.00), size: w * 0.95)
                    .offset(x: drift ? -w * 0.22 : -w * 0.34, y: drift ? -h * 0.30 : -h * 0.22)
                blob(Color(red: 1.00, green: 0.36, blue: 0.62), size: w * 0.80)
                    .offset(x: drift ? w * 0.34 : w * 0.24, y: drift ? -h * 0.04 : -h * 0.14)
                blob(Color(red: 0.30, green: 0.55, blue: 1.00), size: w * 0.85)
                    .offset(x: drift ? -w * 0.08 : w * 0.06, y: drift ? h * 0.36 : h * 0.27)
            }
            .frame(width: w, height: h)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 14).repeatForever(autoreverses: true)) { drift = true }
        }
    }

    private var base: Color {
        scheme == .dark ? Color(red: 0.04, green: 0.04, blue: 0.09) : Color(red: 0.96, green: 0.95, blue: 1.00)
    }

    private func blob(_ color: Color, size: CGFloat) -> some View {
        Circle()
            .fill(color.opacity(scheme == .dark ? 0.30 : 0.26))
            .frame(width: size, height: size)
            .blur(radius: size * 0.28)
    }
}

/// Hapi, Haptune's friendly music note. Drawn with shapes so it stays sharp at any size.
struct HapiMascot: View {
    enum Mood { case happy, think, cheer }

    var size: CGFloat = 80
    var mood: Mood = .happy
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var bob = false

    private var ink: Color { Color(red: 0.18, green: 0.16, blue: 0.31) }
    private var violet: Color { Color(red: 0.48, green: 0.42, blue: 1.00) }

    var body: some View {
        let s = size / 100
        ZStack {
            Path { p in                                        // the note's stem and flag
                p.move(to: CGPoint(x: 70 * s, y: 50 * s))
                p.addLine(to: CGPoint(x: 70 * s, y: 8 * s))
                p.addQuadCurve(to: CGPoint(x: 90 * s, y: 32 * s), control: CGPoint(x: 94 * s, y: 12 * s))
            }
            .stroke(violet, style: StrokeStyle(lineWidth: 7 * s, lineCap: .round, lineJoin: .round))

            Ellipse()                                          // the round body
                .fill(LinearGradient(colors: [Color(red: 0.49, green: 0.42, blue: 1.00),
                                              Color(red: 0.71, green: 0.33, blue: 0.95),
                                              Color(red: 1.00, green: 0.31, blue: 0.55)],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 72 * s, height: 62 * s)
                .position(x: 44 * s, y: 62 * s)

            eye(s).position(x: 33 * s, y: 57 * s)
            eye(s).position(x: 55 * s, y: 57 * s)
            Ellipse().fill(Color.pink.opacity(0.45)).frame(width: 10 * s, height: 6 * s).position(x: 23 * s, y: 69 * s)
            Ellipse().fill(Color.pink.opacity(0.45)).frame(width: 10 * s, height: 6 * s).position(x: 65 * s, y: 69 * s)

            Path { p in                                        // the smile
                p.move(to: CGPoint(x: 37 * s, y: 72 * s))
                p.addQuadCurve(to: CGPoint(x: 51 * s, y: 72 * s),
                               control: CGPoint(x: 44 * s, y: mood == .think ? 75 * s : (mood == .cheer ? 84 * s : 80 * s)))
            }
            .stroke(ink, style: StrokeStyle(lineWidth: 3.4 * s, lineCap: .round))

            if mood == .cheer {
                sparkle(s).position(x: 12 * s, y: 30 * s)
                sparkle(s).position(x: 92 * s, y: 70 * s)
            }
        }
        .frame(width: size, height: size)
        .offset(y: bob ? -2 * s : 2 * s)
        .accessibilityHidden(true)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { bob = true }
        }
    }

    private func eye(_ s: CGFloat) -> some View {
        ZStack {
            Circle().fill(Color.white).frame(width: 14 * s, height: 14 * s)
            Circle().fill(ink).frame(width: 7 * s, height: 7 * s)
                .offset(x: mood == .think ? -1.6 * s : 0.8 * s, y: mood == .think ? -2.2 * s : 0.6 * s)
        }
    }

    private func sparkle(_ s: CGFloat) -> some View {
        Image(systemName: "sparkle")
            .font(.system(size: 14 * s, weight: .bold))
            .foregroundStyle(Color(red: 1.00, green: 0.77, blue: 0.24))
    }
}

/// A speech bubble next to Hapi, for friendly tips and empty states.
struct HapiSays: View {
    var text: LocalizedStringKey
    var mood: HapiMascot.Mood = .happy
    var size: CGFloat = 56

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            HapiMascot(size: size, mood: mood)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
