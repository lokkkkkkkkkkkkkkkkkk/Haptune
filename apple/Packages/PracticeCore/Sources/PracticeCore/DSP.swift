import Foundation

/// Signal processing used by the live follower. Pure Swift (no Accelerate dependency) so it runs and
/// is unit-tested identically on iOS, watchOS, macOS and Linux. Mirrors engine/haptune/dsp.py.
public enum DSP {
    public static let sampleRate = 22050.0
    public static let hop = 256

    // MARK: FFT (iterative radix-2, power-of-two sizes)

    public final class FFT {
        public let n: Int
        private let levels: Int
        private var cosTable: [Double]
        private var sinTable: [Double]
        private var bitrev: [Int]

        public init(size: Int) {
            precondition(size > 1 && size & (size - 1) == 0, "FFT size must be a power of two")
            n = size
            levels = Int(log2(Double(size)))
            cosTable = (0..<size / 2).map { cos(2 * .pi * Double($0) / Double(size)) }
            sinTable = (0..<size / 2).map { sin(2 * .pi * Double($0) / Double(size)) }
            bitrev = (0..<size).map { i in
                var x = i, r = 0
                for _ in 0..<Int(log2(Double(size))) { r = (r << 1) | (x & 1); x >>= 1 }
                return r
            }
        }

        /// In-place complex FFT. `inverse` computes the unscaled inverse transform.
        public func transform(_ re: inout [Double], _ im: inout [Double], inverse: Bool = false) {
            for i in 0..<n {
                let j = bitrev[i]
                if j > i { re.swapAt(i, j); im.swapAt(i, j) }
            }
            var size = 2
            while size <= n {
                let half = size / 2
                let step = n / size
                var i = 0
                while i < n {
                    var k = 0
                    for j in i..<(i + half) {
                        let c = cosTable[k], s = inverse ? sinTable[k] : -sinTable[k]
                        let tre = re[j + half] * c - im[j + half] * s
                        let tim = re[j + half] * s + im[j + half] * c
                        re[j + half] = re[j] - tre; im[j + half] = im[j] - tim
                        re[j] += tre; im[j] += tim
                        k += step
                    }
                    i += size
                }
                size <<= 1
            }
        }

        /// |X(k)| for k in 0...n/2 of a real signal (zero-padded / truncated to n).
        public func magnitude(_ x: [Double], window: [Double]? = nil) -> [Double] {
            var re = [Double](repeating: 0, count: n), im = [Double](repeating: 0, count: n)
            let m = min(n, x.count)
            if let w = window { for i in 0..<m { re[i] = x[i] * w[i] } } else { for i in 0..<m { re[i] = x[i] } }
            transform(&re, &im)
            return (0...(n / 2)).map { (re[$0] * re[$0] + im[$0] * im[$0]).squareRoot() }
        }
    }

    public static func hann(_ n: Int) -> [Double] {
        (0..<n).map { 0.5 - 0.5 * cos(2 * .pi * Double($0) / Double(n - 1)) }
    }

    // MARK: YIN

    public struct YINResult { public let hz: Double; public let cmnd: Double; public let rms: Double }

    /// YIN on one window. `seg` must hold W + tauMax samples. Returns f0 and the CMND value (lower = cleaner).
    public final class YIN {
        public let W: Int, tauMin: Int, tauMax: Int
        public let sampleRate: Double
        private let fft: FFT
        public var threshold = 0.15

        public init(fMin: Double, fMax: Double, sampleRate: Double = DSP.sampleRate) {
            self.sampleRate = sampleRate
            tauMin = max(2, Int(sampleRate / fMax))
            tauMax = Int((sampleRate / max(fMin, 25)).rounded(.up))
            W = Int(pow(2, ceil(log2(max(512, 1.25 * Double(tauMax))))))
            fft = FFT(size: Int(pow(2, ceil(log2(Double(W + tauMax + W))))))
        }

        public var windowLength: Int { W + tauMax }

        public func analyse(_ seg: [Double]) -> YINResult {
            precondition(seg.count >= W + tauMax)
            let n = fft.n
            // r(tau) = sum_j frame[j] * seg[j + tau] via FFT cross-correlation
            var aRe = [Double](repeating: 0, count: n), aIm = [Double](repeating: 0, count: n)
            var bRe = [Double](repeating: 0, count: n), bIm = [Double](repeating: 0, count: n)
            for i in 0..<W { aRe[i] = seg[i] }
            for i in 0..<(W + tauMax) { bRe[i] = seg[i] }
            fft.transform(&aRe, &aIm)
            fft.transform(&bRe, &bIm)
            var cRe = [Double](repeating: 0, count: n), cIm = [Double](repeating: 0, count: n)
            for k in 0..<n {                       // conj(A) * B
                cRe[k] = aRe[k] * bRe[k] + aIm[k] * bIm[k]
                cIm[k] = aRe[k] * bIm[k] - aIm[k] * bRe[k]
            }
            fft.transform(&cRe, &cIm, inverse: true)
            let scale = 1.0 / Double(n)
            var csum = [Double](repeating: 0, count: W + tauMax + 1)
            for i in 0..<(W + tauMax) { csum[i + 1] = csum[i] + seg[i] * seg[i] }
            let e0 = csum[W]
            var d = [Double](repeating: 0, count: tauMax + 1)
            for tau in 1...tauMax {
                d[tau] = max(0, e0 + (csum[tau + W] - csum[tau]) - 2 * cRe[tau] * scale)
            }
            var cmnd = [Double](repeating: 1, count: tauMax + 1)
            var running = 0.0
            for tau in 1...tauMax {
                running += d[tau]
                cmnd[tau] = running > 1e-12 ? d[tau] * Double(tau) / running : 1
            }
            var t = -1
            var tau = tauMin
            while tau < tauMax {
                if cmnd[tau] < threshold {
                    while tau + 1 < tauMax && cmnd[tau + 1] < cmnd[tau] { tau += 1 }
                    t = tau; break
                }
                tau += 1
            }
            if t < 0 {
                var best = tauMin
                for k in tauMin..<tauMax where cmnd[k] < cmnd[best] { best = k }
                t = best
            }
            var shift = 0.0
            if t >= 1 && t < tauMax {
                let a = cmnd[t - 1], b = cmnd[t], c = cmnd[t + 1]
                let den = a - 2 * b + c
                if abs(den) > 1e-12 { shift = min(1, max(-1, 0.5 * (a - c) / den)) }
            }
            let rms = (e0 / Double(W)).squareRoot()
            return YINResult(hz: sampleRate / (Double(t) + shift), cmnd: cmnd[t], rms: rms)
        }
    }

    // MARK: Log-frequency filterbank & harmonic templates

    public struct LogFreqBank {
        public let centers: [Double]            // MIDI value of each band
        public let weights: [[(Int, Double)]]   // sparse rows: (fft bin, weight)

        public init(sampleRate: Double = DSP.sampleRate, fftSize: Int, binsPerSemitone: Int = 3,
                    midiLow: Double = 9, midiHigh: Double = 120) {
            let nb = fftSize / 2 + 1
            let df = sampleRate / Double(fftSize)
            var cs: [Double] = []
            var m = midiLow
            while m < midiHigh { cs.append(m); m += 1.0 / Double(binsPerSemitone) }
            centers = cs
            let width = 1.0 / Double(binsPerSemitone)
            let binMidi: [Double] = (0..<nb).map { $0 == 0 ? -1000 : Pitch.midi(hz: Double($0) * df) }
            weights = cs.map { c in
                var row: [(Int, Double)] = []
                var total = 0.0
                for k in 1..<nb {
                    let w = max(0, 1 - abs(binMidi[k] - c) / width)
                    if w > 0 { row.append((k, w)); total += w }
                }
                if row.isEmpty {
                    let k = Int((Pitch.hz(midi: c) / df).rounded())
                    if k > 0 && k < nb { row = [(k, 1)]; total = 1 }
                }
                return row.map { ($0.0, $0.1 / max(total, 1e-9)) }
            }
        }

        public func apply(_ mag: [Double]) -> [Double] {
            weights.map { row in row.reduce(0) { $0 + mag[$1.0] * $1.1 } }
        }
    }

    public static func harmonicTemplate(pitch: Int, centers: [Double], harmonics: Int = 12,
                                        inharmonicity: Double = 0, slope: Double = 1.1) -> [Double] {
        var t = [Double](repeating: 0, count: centers.count)
        let f0 = Pitch.hz(midi: Double(pitch))
        for h in 1...harmonics {
            let fh = Double(h) * f0 * (1 + inharmonicity * Double(h * h)).squareRoot()
            let mh = Pitch.midi(hz: fh)
            guard let last = centers.last, mh < last else { break }
            let amp = pow(Double(h), -slope)
            for i in 0..<centers.count {
                let z = (centers[i] - mh) / 0.35
                if abs(z) < 4 { t[i] += amp * exp(-0.5 * z * z) }
            }
        }
        let norm = t.reduce(0) { $0 + $1 * $1 }.squareRoot()
        return norm > 0 ? t.map { $0 / norm } : t
    }

    /// KL-NMF activations for a handful of frames with a fixed dictionary: V(frames x bins) ~ H W.
    public static func nmfActivations(V: [[Double]], W: [[Double]], iterations: Int = 40) -> [[Double]] {
        let eps = 1e-12
        let K = W.count, B = W.first?.count ?? 0
        let mean = max(eps, V.flatMap { $0 }.reduce(0, +) / Double(max(1, V.count * B)))
        var H = V.map { _ in [Double](repeating: mean, count: K) }
        let wsum = W.map { $0.reduce(0, +) + eps }
        for _ in 0..<iterations {
            for f in 0..<V.count {
                var approx = [Double](repeating: eps, count: B)
                for k in 0..<K where H[f][k] > 0 {
                    let h = H[f][k]
                    for b in 0..<B { approx[b] += h * W[k][b] }
                }
                for k in 0..<K {
                    var num = 0.0
                    for b in 0..<B where W[k][b] > 1e-6 { num += W[k][b] * V[f][b] / approx[b] }
                    H[f][k] *= num / wsum[k]
                }
            }
        }
        return H
    }
}
