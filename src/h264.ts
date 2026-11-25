// H.264 fix-ups for the live screen (src/live-screen.ts). cua-spacesd's macOS encoder writes sequence parameter sets
// (SPS) with no VUI, so the stream never says that no frame waits to be reordered. A decoder that follows the spec, such
// as Chrome's hardware decoder on Windows, then holds frames back to fill the largest picture buffer the level allows:
// at 1080p and level 4.0 that is 4 frames, about 300 ms at 15 fps, measured on 2026-11-24. openLiveStream in
// src/computer.ts runs every frame through lowLatencyH264 before the web portal sees it.

/**
 * Returns the Annex-B access unit with each SPS that lacks a VUI given one that says no frame is reordered, so
 * decoders output each frame as soon as it is decoded. Frames without such an SPS come back unchanged (the same array).
 */
export function lowLatencyH264(accessUnit: Uint8Array): Uint8Array {
	const units = nalUnits(accessUnit);
	let changed = false;
	const parts = units.map(({ start, end }) => {
		const nal = accessUnit.subarray(start, end);
		if ((nal[0]! & 0x1f) !== 7) return nal;
		const patched = lowLatencySps(unescape(nal.subarray(1)));
		if (patched === undefined) return nal;
		changed = true;
		return Uint8Array.of(nal[0]!, ...escape(patched));
	});
	if (!changed) return accessUnit;
	const out = new Uint8Array(parts.reduce((total, part) => total + 4 + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set([0, 0, 0, 1], at);
		out.set(part, at + 4);
		at += 4 + part.length;
	}
	return out;
}

// Where each NAL unit's bytes start and end, after its 3- or 4-byte start code.
function nalUnits(data: Uint8Array): { start: number; end: number }[] {
	const starts: number[] = [];
	for (let i = 0; i + 2 < data.length; i++) {
		if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
			starts.push(i + 3);
			i += 2;
		}
	}
	return starts.map((start, n) => {
		let end = n + 1 < starts.length ? starts[n + 1]! - 3 : data.length;
		// A 4-byte start code's leading zero, and trailing zeros, belong to no NAL unit.
		while (end > start && data[end - 1] === 0) end--;
		return { start, end };
	});
}

// NAL payload to RBSP: drops each emulation-prevention 0x03 that follows two zero bytes.
function unescape(payload: Uint8Array): Uint8Array {
	const out: number[] = [];
	let zeros = 0;
	for (const byte of payload) {
		if (zeros >= 2 && byte === 3) {
			zeros = 0;
			continue;
		}
		out.push(byte);
		zeros = byte === 0 ? zeros + 1 : 0;
	}
	return Uint8Array.from(out);
}

// RBSP to NAL payload: puts 0x03 after two zero bytes wherever the next byte is 0 to 3.
function escape(rbsp: Uint8Array): number[] {
	const out: number[] = [];
	let zeros = 0;
	for (const byte of rbsp) {
		if (zeros >= 2 && byte <= 3) {
			out.push(3);
			zeros = 0;
		}
		out.push(byte);
		zeros = byte === 0 ? zeros + 1 : 0;
	}
	return out;
}

// Profiles whose SPS carries chroma format, bit depths and scaling matrices (H.264 7.3.2.1.1).
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/**
 * The SPS's RBSP with a VUI holding only bitstream_restriction (no reordering, a buffer of max_num_ref_frames), or
 * undefined when it already has a VUI or carries scaling matrices, which this doesn't parse.
 */
export function lowLatencySps(rbsp: Uint8Array): Uint8Array | undefined {
	const read = bitReader(rbsp);
	try {
		const profile = read.bits(8);
		read.bits(16); // constraint flags and level
		read.ue(); // seq_parameter_set_id
		if (HIGH_PROFILES.has(profile)) {
			if (read.ue() === 3) read.bits(1); // chroma_format_idc, separate_colour_plane_flag
			read.ue(); // bit_depth_luma_minus8
			read.ue(); // bit_depth_chroma_minus8
			read.bits(1); // qpprime_y_zero_transform_bypass_flag
			if (read.bits(1) === 1) return undefined; // seq_scaling_matrix_present_flag
		}
		read.ue(); // log2_max_frame_num_minus4
		const pocType = read.ue();
		if (pocType === 0) read.ue();
		else if (pocType === 1) {
			read.bits(1);
			read.se();
			read.se();
			const cycle = read.ue();
			for (let i = 0; i < cycle; i++) read.se();
		}
		const refFrames = read.ue();
		read.bits(1); // gaps_in_frame_num_value_allowed_flag
		read.ue(); // pic_width_in_mbs_minus1
		read.ue(); // pic_height_in_map_units_minus1
		if (read.bits(1) === 0) read.bits(1); // frame_mbs_only_flag, mb_adaptive_frame_field_flag
		read.bits(1); // direct_8x8_inference_flag
		if (read.bits(1) === 1) for (let i = 0; i < 4; i++) read.ue(); // frame cropping
		const vuiAt = read.position();
		if (read.bits(1) === 1) return undefined;

		const write = bitWriter();
		for (let i = 0; i < vuiAt; i++) write.bits((rbsp[i >> 3]! >> (7 - (i & 7))) & 1, 1);
		write.bits(1, 1); // vui_parameters_present_flag
		// aspect ratio, overscan, video signal, chroma location, timing, NAL HRD, VCL HRD, pic_struct: all absent.
		write.bits(0, 8);
		write.bits(1, 1); // bitstream_restriction_flag
		write.bits(1, 1); // motion_vectors_over_pic_boundaries_flag
		write.ue(2); // max_bytes_per_pic_denom (the default)
		write.ue(1); // max_bits_per_mb_denom (the default)
		write.ue(16); // log2_max_mv_length_horizontal (the default)
		write.ue(16); // log2_max_mv_length_vertical (the default)
		write.ue(0); // max_num_reorder_frames
		write.ue(Math.max(1, refFrames)); // max_dec_frame_buffering
		write.bits(1, 1); // rbsp_stop_one_bit, then zeros to the byte boundary
		return write.bytes();
	} catch {
		return undefined; // a truncated SPS: leave it to the decoder
	}
}

function bitReader(data: Uint8Array) {
	let at = 0;
	const bit = () => {
		if (at >= data.length * 8) throw new RangeError("SPS ends early");
		const value = (data[at >> 3]! >> (7 - (at & 7))) & 1;
		at++;
		return value;
	};
	const bits = (count: number) => {
		let value = 0;
		for (let i = 0; i < count; i++) value = value * 2 + bit();
		return value;
	};
	const ue = () => {
		let zeros = 0;
		while (bit() === 0) zeros++;
		return 2 ** zeros - 1 + bits(zeros);
	};
	return {
		bits,
		ue,
		se: () => {
			const code = ue();
			return code % 2 === 1 ? (code + 1) / 2 : -code / 2;
		},
		position: () => at,
	};
}

function bitWriter() {
	const out: number[] = [];
	let at = 0;
	const bits = (value: number, count: number) => {
		for (let i = count - 1; i >= 0; i--) {
			if ((at & 7) === 0) out.push(0);
			if (Math.floor(value / 2 ** i) % 2 === 1) out[out.length - 1]! |= 0x80 >> (at & 7);
			at++;
		}
	};
	return {
		bits,
		ue: (value: number) => {
			const code = value + 1;
			const length = Math.floor(Math.log2(code)) + 1;
			bits(0, length - 1);
			bits(code, length);
		},
		bytes: () => Uint8Array.from(out),
	};
}
