import PracticeCore
import SwiftUI

/// Colour and symbol per instrument family, used for icons across the app (like Health's categories).
enum InstrumentStyle {
    static func symbol(for key: String) -> String {
        switch family(key) {
        case "keys": return "pianokeys"
        case "plucked": return "guitars"
        case "voice": return "music.mic"
        case "percussion": return "metronome"
        case "wind": return "music.note"
        default: return "music.quarternote.3"
        }
    }

    static func color(for key: String) -> Color {
        switch family(key) {
        case "keys": return .blue
        case "plucked": return .green
        case "voice": return .pink
        case "percussion": return .gray
        case "wind": return .teal
        default: return .orange
        }
    }

    static func family(_ key: String) -> String {
        let k = key.lowercased()
        if ["piano", "keyboard"].contains(k) { return "keys" }
        if ["guitar", "ukulele", "bass_guitar", "guzheng"].contains(k) { return "plucked" }
        if k.hasPrefix("voice") { return "voice" }
        if k == "percussion" { return "percussion" }
        if ["flute", "recorder", "dizi", "clarinet", "alto_sax", "tenor_sax", "trumpet", "trombone", "french_horn"].contains(k) { return "wind" }
        return "bowed"
    }

    static func symbol(for item: LibraryItem) -> String {
        switch item.sourceKind {
        case "split": return "slider.vertical.3"
        case "exercise": return "stairs"
        default: return symbol(for: item.instrument)
        }
    }

    static func color(for item: LibraryItem) -> Color {
        switch item.sourceKind {
        case "split": return .purple
        case "exercise": return .indigo
        default: return color(for: item.instrument)
        }
    }

    static func color(forRole role: String) -> Color {
        switch role {
        case "vocals": return .pink
        case "lead": return .orange
        case "keys": return .blue
        case "bass": return .green
        case "drums": return .gray
        default: return .teal
        }
    }

    static func symbol(forRole role: String, instrument: String) -> String {
        switch role {
        case "vocals": return "music.mic"
        case "drums": return "metronome"
        case "bass": return "waveform"
        default: return symbol(for: instrument)
        }
    }
}

/// A rounded-square icon like the ones in Settings and Health.
struct IconBadge: View {
    let symbol: String
    let color: Color
    var size: CGFloat = 30

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color.gradient, in: RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// A Health-style summary card: coloured category header, big value, optional chart.
struct SummaryCard<Content: View>: View {
    let title: LocalizedStringKey
    let symbol: String
    let tint: Color
    var detail: String?
    var showsChevron = true
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: symbol)
                Text(title)
                Spacer(minLength: 8)
                if let detail {
                    Text(detail).foregroundStyle(.secondary).font(.footnote)
                }
                if showsChevron {
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(tint)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// "24 min" with Health's rounded numerals.
struct BigValue: View {
    let value: String
    var unit: String = ""

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(value).font(.system(.title, design: .rounded).weight(.semibold)).monospacedDigit()
            if !unit.isEmpty { Text(unit).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary) }
        }
        .foregroundStyle(.primary)
    }
}

struct SectionTitle: View {
    let title: LocalizedStringKey
    var body: some View {
        Text(title)
            .font(.title2.weight(.bold))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Small "PLUS" capsule shown next to features that need Haptune Plus.
struct PlusBadge: View {
    var body: some View {
        Text("PLUS")
            .font(.caption2.weight(.heavy))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(.white)
            .background(LinearGradient(colors: [.purple, .pink], startPoint: .leading, endPoint: .trailing), in: Capsule())
            .accessibilityLabel(Text("Requires Haptune Plus"))
    }
}

/// When each part plays, as a strip of soft bars (one per second).
struct ActivityStrip: View {
    let activity: [Double]
    let color: Color
    var progress: Double? = nil         // 0...1 playhead

    var body: some View {
        GeometryReader { geo in
            let n = max(1, activity.count)
            let w = geo.size.width / CGFloat(n)
            ZStack(alignment: .leading) {
                HStack(alignment: .center, spacing: 0) {
                    ForEach(Array(activity.enumerated()), id: \.offset) { _, a in
                        RoundedRectangle(cornerRadius: 1)
                            .fill(color.opacity(a > 0.05 ? 0.35 + 0.65 * a : 0.12))
                            .frame(width: max(0.5, w - 0.5), height: max(2, geo.size.height * (0.25 + 0.75 * a)))
                            .frame(width: w)
                    }
                }
                if let p = progress {
                    Rectangle().fill(Color.primary).frame(width: 1.5).offset(x: geo.size.width * CGFloat(min(1, max(0, p))))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// Chip used to pick instruments ("Who's playing?").
struct ChoiceChip: View {
    let title: String
    let symbol: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .foregroundStyle(selected ? Color.white : Color.primary)
                .background(selected ? Color.accentColor : Color(uiColor: .tertiarySystemFill), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Wraps chips onto several lines.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 { x = 0; y += rowH + spacing; rowH = 0 }
            x += size.width + spacing
            rowH = max(rowH, size.height)
        }
        return CGSize(width: width, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowH = max(rowH, size.height)
        }
    }
}

extension Double {
    /// 3:05
    var clock: String {
        let s = Int(self.rounded(.down))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}
