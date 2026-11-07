//@name interlude
//@display-name Interlude v1.3.2
//@api 3.0
//@version 1.3.2
//@update-url https://raw.githubusercontent.com/Nicered/interlude-risu/main/interlude.js
//@arg model_slot string 쓸 모델. aux는 Risu 보조 모델, main은 Risu 메인 모델입니다.
//@arg nai_key string NovelAI API 키 (사진 기능). Interlude 설정 → 시작 준비에서 입력합니다.
(function() {

//#region src/core/budget.js
	const CONTEXT_PRESETS = {
		light: {
			analysis: 5e3,
			description: 4e3,
			persona: 3e3,
			replyMember: 5e3,
			replyTotal: 12e3,
			roomHistory: 8e3
		},
		standard: {
			analysis: 2e4,
			description: 16e3,
			persona: 6e3,
			replyMember: 12e3,
			replyTotal: 48e3,
			roomHistory: 24e3
		},
		large: {
			analysis: 4e4,
			description: 32e3,
			persona: 12e3,
			replyMember: 24e3,
			replyTotal: 96e3,
			roomHistory: 48e3
		}
	};
	const BUDGET_LABELS = {
		light: "경량",
		standard: "기본",
		large: "확장",
		custom: "직접 설정",
		basic: "경량"
	};
	const BUDGET_MODES = [
		["light", "경량"],
		["standard", "기본"],
		["large", "확장"]
	];
	const LEGACY_LIGHT = () => ({
		mode: "basic",
		...CONTEXT_PRESETS.light
	});
	const budgetSaves = new Set();
	const CONTEXT_FIELDS = [
		[
			"analysis",
			"인물 분석 분량",
			500,
			1e5
		],
		[
			"description",
			"답장에 넣을 봇 설명",
			500,
			1e5
		],
		[
			"persona",
			"답장에 넣을 내 페르소나",
			500,
			3e4
		],
		[
			"replyMember",
			"답장에 넣을 인물별 설정",
			500,
			5e4
		],
		[
			"replyTotal",
			"참가자 설정 전체 상한",
			1e3,
			2e5
		],
		[
			"roomHistory",
			"답장에 넣을 메신저 기록",
			1e3,
			1e5
		]
	];
	const MODES = {
		story: {
			label: "본편 중심",
			story: 16e3,
			summary: 6e3,
			desc: "메신저 시간이 본편 마지막 장면에 머물고, 본편 사건에 반응합니다."
		},
		balanced: {
			label: "균형",
			story: 1e4,
			summary: 5e3,
			desc: "본편 마지막 장면을 기준으로, 대화가 이어지면 이야기 속 시간도 조금씩 흐르며 본편 이야기와 일상을 섞습니다."
		},
		free: {
			label: "자율 대화",
			story: 4e3,
			summary: 3e3,
			desc: "본편은 지난 일로 참고하고, 근황과 새 화제를 중심으로 대화합니다."
		}
	};
	const modeOf = (state) => Object.hasOwn(MODES, state?.mode || "") ? state.mode : "balanced";
	function validateContextBudget(input) {
		const mode = input?.mode || "basic";
		if (mode === "basic") return LEGACY_LIGHT();
		if (mode === "expanded") return {
			mode: "standard",
			...CONTEXT_PRESETS.standard
		};
		if (Object.hasOwn(CONTEXT_PRESETS, mode)) return {
			mode,
			...CONTEXT_PRESETS[mode]
		};
		if (mode !== "custom") throw new Error("설정 분량 모드를 확인해 주세요.");
		const preset = CONTEXT_PRESETS[input?.preset];
		if (Object.hasOwn(CONTEXT_PRESETS, input?.preset || "") && Object.keys(preset).every((k) => Number(input[k]) === preset[k])) return {
			mode: input.preset,
			...preset
		};
		const result = { mode };
		for (const [key, label, min, max] of CONTEXT_FIELDS) {
			const value = Number(key === "roomHistory" ? input[key] ?? CONTEXT_PRESETS.light.roomHistory : input[key]);
			if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}은 ${min.toLocaleString()}~${max.toLocaleString()}자의 정수로 입력해 주세요.`);
			result[key] = value;
		}
		if (result.replyTotal < result.replyMember) throw new Error("참가자 설정 전체 상한은 인물별 설정 분량 이상이어야 해요.");
		return result;
	}
	function backupBudget(budget) {
		return Object.hasOwn(CONTEXT_PRESETS, budget.mode) ? {
			...budget,
			mode: "custom",
			preset: budget.mode
		} : budget;
	}
	function contextBudget(state) {
		try {
			return validateContextBudget(state?.contextBudget);
		} catch {
			return LEGACY_LIGHT();
		}
	}
	function budgetText(value, limit, section, report, memberId) {
		const text = String(value || ""), used = text.slice(0, Math.max(0, limit));
		if (report) report.push({
			section,
			...memberId ? { memberId } : {},
			sourceChars: text.length,
			usedChars: used.length,
			limit: Math.max(0, limit),
			truncated: used.length < text.length
		});
		return used;
	}
	function contextUsageText(rows) {
		const labels = {
			analysis: "인물 분석 원문",
			description: "봇 설명",
			persona: "내 페르소나",
			member: "참가자 설정",
			story: "최근 줄거리",
			storyMemory: "본편 메모리",
			storyView: "인물별 줄거리",
			room: "메신저 기록",
			chatMemory: "대화 메모리"
		};
		return (rows || []).map((r, i) => `${i + 1}. ${labels[r.section] || r.section}: ${r.sourceChars.toLocaleString()}자 중 ${r.usedChars.toLocaleString()}자 사용${r.truncated ? " · 잘림" : ""}`).join("\n");
	}

//#endregion
//#region src/core/constants.js
	const PLUGIN_VERSION = "1.3.2";
	const STORE_PREFIX = "interlude:v1:";
	const STORY_CHARS = 16e3;
	const SUMMARY_CHARS = 6e3;
	const LORE_PER_MEMBER = 5e3;
	const LORE_TOTAL = 12e3;
	const INJECT_LINES = 20;
	const MEMORY_EVERY = 12;
	const MEMORY_BATCH = 60;
	const MEMORY_RUNS = 40;
	const MEMORY_ACTIVE = 40;
	const MEMORY_ARCHIVE = 500;
	const MEMORY_TEXT = 200;
	const MEMORY_CHARS = 4e3;
	const MEMORY_RECALL = 1e3;
	const MEMORY_INJECT = 1500;
	const MAX_ROOM_MSGS = 500;
	const TERMS_PREFIX = "interlude:terms:";
	const ASSET_CACHE = "interlude:assets:";
	const HEAD_CACHE = "interlude:head:";
	const HEAD_SIZE = 192;
	const OWN_MARK = "⁣";
	const SCAN_BATCH = 120;
	const TERM_BATCH = 150;
	const RELEVANT_LORE = 600;
	const ANALYSIS_TOKENS = 2e3;
	const CONFIRM_FROM = 20;
	const AUTO_RESCAN_AFTER = 10;
	const OPENING_CHARS = 4e3;
	const IMAGE_SETTINGS = "interlude:image:v1";
	const UI_SETTINGS = "interlude:ui:v1";
	const IMAGE_TAGS_PREFIX = "interlude:imagetags:v1:";
	const PHOTO_PREFIX = "interlude:photo:v1:";
	const THUMB_WIDTH = 360;
	const THUMB_CACHE = 300;
	const NAI_ENDPOINT = "https://image.novelai.net/ai/generate-image";
	const NAI_SUGGEST = "https://image.novelai.net/ai/generate-image/suggest-tags";

//#endregion
//#region src/syslog/log.js
	const SYSTEM_KEY = "interlude:system-log:v1";
	const SYSTEM_MAX = 200;
	const SYSTEM_BUDGET = 2e6;
	const SYSTEM_KINDS = {
		model: "모델 요청",
		"reply-model": "답장 모델 요청",
		"story-view": "인물별 줄거리",
		polish: "말투로 다듬기",
		scan: "인물 찾기",
		analysis: "인물 분석",
		bio: "상태메시지 생성",
		terms: "사전 생성",
		"image-tags": "사진 태그 분석",
		memory: "메모리 정리",
		"image-request": "사진 생성 요청",
		"tag-request": "태그 조회 요청",
		photo: "사진 처리",
		send: "메시지 전송",
		reply: "답장 처리",
		storage: "데이터 저장",
		load: "데이터 불러오기",
		open: "메신저 열기",
		environment: "환경 정보"
	};
	const SYSTEM_STATUS = {
		running: "진행 중",
		success: "성공",
		failed: "실패",
		partial: "일부 실패",
		cancelled: "중단",
		skipped: "생략/캐시",
		interrupted: "이전 실행 중단"
	};
	let systemRows = null;
	let systemLoading = null;
	let systemQueue = Promise.resolve();
	let systemEpoch = 0;
	let systemStorageError = false;
	let systemEnvironment = null;
	SYSTEM_KINDS.edit = "메시지 수정";
	SYSTEM_KINDS.settings = "설정 분량 변경";
	SYSTEM_KINDS["photo-plan"] = "사진 장면 태그 작성";
	function systemWait(promise) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve({ ok: false }), 500);
			Promise.resolve(promise).then((value) => {
				clearTimeout(timer);
				resolve({
					ok: true,
					value
				});
			}, () => {
				clearTimeout(timer);
				resolve({ ok: false });
			});
		});
	}
	function systemRecord(e) {
		const out = {
			id: debugExcerpt(e.id, 100),
			t: Number(e.t) || Date.now(),
			version: debugExcerpt(e.version || "1.0.3", 30),
			kind: Object.hasOwn(SYSTEM_KINDS, e.kind) ? e.kind : "model",
			status: Object.hasOwn(SYSTEM_STATUS, e.status) ? e.status : "failed"
		};
		for (const k of [
			"parentId",
			"phase",
			"slot",
			"responseType",
			"parseMode",
			"purpose"
		]) out[k] = debugExcerpt(e[k], 120);
		for (const k of [
			"durationMs",
			"endedAt",
			"requestChars",
			"rawChars",
			"processedChars",
			"chunks",
			"accepted",
			"delivered",
			"httpStatus",
			"attempt"
		]) if (Number.isFinite(e[k])) out[k] = e[k];
		out.request = debugExcerpt(e.request, 8e3);
		out.raw = debugExcerpt(e.raw, 16e3);
		out.error = debugExcerpt(e.error, 2e3);
		out.requestChars = e.requestChars ?? String(e.request || "").length;
		out.rawChars = e.rawChars ?? String(e.raw || "").length;
		out.requestTruncated = !!e.requestTruncated || out.requestChars > 8e3;
		out.rawTruncated = !!e.rawTruncated || out.rawChars > 16e3;
		out.reasons = (Array.isArray(e.reasons) ? e.reasons : []).slice(0, 40).map((r) => ({
			i: Number(r.i),
			why: debugExcerpt(r.why, 300)
		}));
		const usage = Array.isArray(e.contextUsage) ? e.contextUsage : [];
		out.contextUsage = usage.slice(0, 2002).map((r) => ({
			section: [
				"analysis",
				"description",
				"persona",
				"member",
				"story",
				"storyMemory",
				"room",
				"chatMemory"
			].includes(r.section) ? r.section : "member",
			sourceChars: Number(r.sourceChars) || 0,
			usedChars: Number(r.usedChars) || 0,
			limit: Number(r.limit) || 0,
			truncated: !!r.truncated
		}));
		out.contextUsageOmitted = Math.max(0, usage.length - 2002);
		return out;
	}
	async function systemLoad() {
		if (systemRows) return systemRows;
		if (!systemLoading) systemLoading = (async () => {
			try {
				const read = await systemWait(risuai.pluginStorage.getItem(SYSTEM_KEY));
				if (!read.ok) throw new Error("Log storage unavailable");
				const raw = read.value;
				const value = typeof raw === "string" ? JSON.parse(raw) : raw;
				systemRows = (Array.isArray(value) ? value : []).filter((e) => e && typeof e === "object").slice(0, SYSTEM_MAX).map((e) => systemRecord({
					...e,
					status: e.status === "running" ? "interrupted" : e.status
				}));
			} catch {
				systemRows = [];
				systemStorageError = true;
			}
			return systemRows;
		})();
		return systemLoading;
	}
	async function systemWrite(e) {
		const epoch = e._epoch;
		const record = systemRecord(e);
		await systemLoad();
		if (epoch !== systemEpoch) return;
		const index = systemRows.findIndex((row) => row.id === record.id);
		if (index >= 0) systemRows[index] = record;
		else systemRows.unshift(record);
		systemRows.sort((a, b) => b.t - a.t);
		systemRows.length = Math.min(systemRows.length, SYSTEM_MAX);
		systemScheduleFlush();
	}
	const SYSTEM_FLUSH_MS = 1e3;
	let systemFlushTimer = null;
	function systemScheduleFlush() {
		if (!systemFlushTimer) systemFlushTimer = setTimeout(systemFlush, SYSTEM_FLUSH_MS);
	}
	function systemFlush() {
		clearTimeout(systemFlushTimer);
		systemFlushTimer = null;
		const epoch = systemEpoch;
		systemQueue = systemQueue.then(async () => {
			if (epoch !== systemEpoch || !systemRows) return;
			const parts = systemRows.map((row) => JSON.stringify(row));
			let count = parts.length;
			let length = 2 + parts.reduce((sum, part) => sum + part.length, 0) + Math.max(0, count - 1);
			while (length > SYSTEM_BUDGET && count > 1) length -= parts[--count].length + 1;
			systemRows.length = count;
			const data = "[" + parts.slice(0, count).join(",") + "]";
			await risuai.pluginStorage.setItem(SYSTEM_KEY, data);
			systemStorageError = false;
		}).catch(() => {
			systemStorageError = true;
		});
		return systemQueue;
	}
	async function systemStart(kind, fields = {}) {
		const e = {
			version: PLUGIN_VERSION,
			...fields,
			id: newId(),
			t: Date.now(),
			kind,
			status: "running",
			_epoch: systemEpoch
		};
		await systemWrite(e);
		return e;
	}
	async function systemEnd(e, status = "success", error) {
		e.status = status;
		e.endedAt = Date.now();
		e.durationMs = e.endedAt - e.t;
		if (error) e.error = String(error.message || error);
		await systemWrite(e);
	}
	async function systemFailure(kind, error, phase) {
		const e = await systemStart(kind, { phase });
		await systemEnd(e, "failed", error);
	}
	async function systemClear() {
		systemEpoch++;
		await systemLoad();
		systemRows = [];
		systemQueue = systemQueue.then(async () => {
			await risuai.pluginStorage.removeItem(SYSTEM_KEY);
			systemStorageError = false;
		}).catch(() => {
			systemStorageError = true;
		});
		if (!(await systemWait(systemQueue)).ok) systemStorageError = true;
	}
	async function systemEnvironmentRefresh() {
		const env = {
			collectedAt: new Date().toISOString(),
			interlude: PLUGIN_VERSION,
			appVersion: "unavailable",
			apiVersion: typeof risuai.apiVersion === "string" ? risuai.apiVersion : "unavailable",
			browser: debugExcerpt(typeof navigator === "object" ? navigator.userAgent : "", 400),
			pluginsStatus: "unavailable",
			plugins: []
		};
		try {
			const response = await systemWait(risuai.getDatabase(["plugins"]));
			const db = response.ok ? response.value : null;
			if (Array.isArray(db?.plugins)) {
				env.pluginsStatus = "available";
				env.plugins = db.plugins.slice(0, 200).map((p) => ({
					name: debugExcerpt(p.name, 150),
					displayName: debugExcerpt(p.displayName, 150),
					version: debugExcerpt(p.versionOfPlugin || "unavailable", 80),
					apiVersion: debugExcerpt(p.version ?? "unavailable", 40),
					enabled: typeof p.enabled === "boolean" ? p.enabled : null
				}));
				env.pluginsTruncated = db.plugins.length > 200;
			}
		} catch {}
		systemEnvironment = env;
		return env;
	}
	function systemExport(includeText, entries = systemRows || []) {
		return {
			type: "interlude-system-log",
			schema: 1,
			pluginVersion: PLUGIN_VERSION,
			exportedAt: new Date().toISOString(),
			includesText: !!includeText,
			scope: "Interlude operations only. Environment is an export-time snapshot, not historical request configuration. Host app version, actual model/effort and other plugins internal logs are unavailable.",
			environment: systemEnvironment,
			entries: entries.map((e) => {
				const row = systemRecord(e);
				if (!includeText) {
					delete row.request;
					delete row.raw;
					delete row.error;
					row.reasonCount = row.reasons.length;
					delete row.reasons;
				}
				return row;
			})
		};
	}
	function systemInstrument(kind, fn, outcome) {
		return async function(...args) {
			const started = systemStart(kind);
			try {
				const result = await fn.apply(this, args);
				const verdict = outcome ? outcome(result, args) : null;
				await systemEnd(await started, verdict?.status || "success", verdict?.error);
				return result;
			} catch (error) {
				await systemEnd(await started, "failed", error);
				throw error;
			}
		};
	}

//#endregion
//#region src/core/text.js
	function cleanStory(text) {
		return String(text || "").replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").replace(/```[\s\S]*?```/g, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>\n]{1,300}>/g, "").replace(/\{\{[^{}]*\}\}/g, "").replace(/\n{3,}/g, "\n\n").trim();
	}
	function recentWindow(chat, limit) {
		const out = [], ids = new Set();
		let left = limit;
		const msgs = chat.message || [];
		for (let i = msgs.length - 1; i >= 0 && left > 0; i--) {
			const text = cleanStory(msgs[i].data);
			if (!text) continue;
			const piece = (msgs[i].role === "user" ? "[PC] " : "") + text;
			out.unshift(piece.length > left ? piece.slice(piece.length - left) : piece);
			if (msgs[i].chatId) ids.add(msgs[i].chatId);
			left -= piece.length;
		}
		return {
			text: out.join("\n\n"),
			ids
		};
	}
	async function storyWindow(ctx, limit) {
		const win = recentWindow(ctx.chat, limit);
		if ((ctx.chat.message || []).length >= 3) return win;
		const index = ctx.chat.fmIndex ?? -1;
		const greeting = index >= 0 ? ctx.char.alternateGreetings?.[index] : ctx.char.firstMessage;
		const opening = cleanStory(await parseCbs(greeting)).slice(0, Math.min(limit, OPENING_CHARS));
		return {
			text: [opening && `(도입부 일부. 배경 참고용이며 여기 나온 정보로 참가자의 정체를 판단하지 않는다)\n${opening}`, win.text].filter(Boolean).join("\n\n"),
			ids: win.ids
		};
	}
	async function hypaPlusEvents(ctx, recentIds) {
		let data = await risuai.pluginStorage.getItem("hypaplus_state_" + ctx.char.chaId + "_" + ctx.chat.id);
		if (typeof data === "string") data = JSON.parse(data);
		if (!Array.isArray(data?.chunks)) return [];
		const present = new Set((ctx.chat.message || []).map((m) => m.chatId).filter(Boolean));
		const events = [];
		for (const chunk of data.chunks) {
			const ids = Array.isArray(chunk.chatIds) ? chunk.chatIds : [];
			if (!ids.some((id) => present.has(id)) || ids.every((id) => recentIds.has(id))) continue;
			const nodes = Array.isArray(chunk.nodes) ? chunk.nodes : [];
			for (const node of nodes) {
				const body = String(node?.content || node?.text || "").trim();
				if (!body) continue;
				const when = [node.time, node.location].filter(Boolean).join(" · ");
				events.push({
					text: when ? `- ${when}: ${body}` : `- ${body}`,
					who: Array.isArray(node.characters) ? node.characters.map(normalize) : []
				});
			}
			if (!nodes.length && typeof chunk.summarized === "string" && chunk.summarized.trim()) events.push({
				text: "- " + chunk.summarized.trim(),
				who: []
			});
		}
		return events;
	}
	const STORY_SOURCES = [
		["auto", "자동"],
		["hypaplus", "요약 플러그인 (HypaPlus)"],
		["hypav3", "Risu 장기기억"],
		["hypav2", "Risu 장기기억 (이전 V2)"],
		["supa", "Risu 장기기억 (이전 SupaMemory)"]
	];
	const sourceLabel = (id) => (STORY_SOURCES.find((s) => s[0] === id) || ["", "없음"])[1];
	function risuSummaries(chat, kind, recentIds) {
		const present = new Set((chat.message || []).map((m) => m.chatId).filter(Boolean));
		const keep = (memos) => {
			const ids = (Array.isArray(memos) ? memos : []).filter(Boolean);
			return !ids.length || ids.some((id) => present.has(id)) && !ids.every((id) => recentIds.has(id));
		};
		const lines = (list) => list.filter((s) => s && keep(s.chatMemos)).map((s) => ({
			text: "- " + String(s.text || "").trim(),
			who: [],
			important: s.isImportant === true
		})).filter((e) => e.text.length > 2);
		if (kind === "hypav3") return lines(Array.isArray(chat.hypaV3Data?.summaries) ? chat.hypaV3Data.summaries : []);
		if (kind === "hypav2") return lines(Array.isArray(chat.hypaV2Data?.mainChunks) ? chat.hypaV2Data.mainChunks : []);
		if (kind === "supa") {
			const rows = String(chat.supaMemoryData || "").trim().split("\n");
			const body = (/^\S{1,64}$/.test(rows[0]) ? rows.slice(1) : rows).join("\n").trim();
			return body ? [{
				text: body,
				who: [],
				whole: true
			}] : [];
		}
		return [];
	}
	async function legacySummary(ctx, members, recentIds) {
		let events = [];
		try {
			events = await hypaPlusEvents(ctx, recentIds);
		} catch (e) {
			console.log("[interlude] summary plugin failed: " + e.message);
			void systemFailure("load", e, "summary plugin failed");
		}
		if (!events.length) events = (ctx.chat.hypaV3Data?.summaries || []).map((s) => ({
			text: "- " + String(s.text || "").trim(),
			who: []
		})).filter((e) => e.text.length > 2);
		const names = members.flatMap((m) => [m.name, ...m.aliases || []]).map(normalize).filter((n) => n.length >= 2);
		const related = (e) => e.who.some((w) => names.some((n) => w.includes(n) || n.includes(w))) || names.some((n) => normalize(e.text).includes(n));
		const picked = new Set();
		let left = SUMMARY_CHARS;
		for (const pass of [related, () => true]) {
			for (let i = events.length - 1; i >= 0; i--) {
				const e = events[i];
				if (picked.has(e) || e.text.length + 1 > left || !pass(e)) continue;
				picked.add(e);
				left -= e.text.length + 1;
			}
		}
		return events.filter((e) => picked.has(e)).map((e) => e.text).join("\n");
	}
	async function storyMemory(ctx, members, recentIds, limit, source = "auto") {
		const order = source === "auto" ? [
			"hypaplus",
			"hypav3",
			"hypav2",
			"supa"
		] : [source];
		let events = [], used = "";
		for (const kind of order) {
			if (kind === "hypaplus") {
				try {
					events = await hypaPlusEvents(ctx, recentIds);
				} catch (e) {
					events = [];
					console.log("[interlude] summary plugin failed: " + e.message);
					void systemFailure("load", e, "summary plugin failed");
				}
			} else events = risuSummaries(ctx.chat, kind, recentIds);
			if (events.length) {
				used = kind;
				break;
			}
		}
		if (events.length === 1 && events[0].whole) {
			const text = events[0].text.slice(-limit);
			return {
				text,
				source: used,
				total: 1,
				used: text ? 1 : 0
			};
		}
		const names = members.flatMap((m) => [m.name, ...m.aliases || []]).map(normalize).filter((n) => n.length >= 2);
		const related = (e) => e.who.some((w) => names.some((n) => w.includes(n) || n.includes(w))) || names.some((n) => normalize(e.text).includes(n));
		const picked = new Set();
		let left = limit;
		for (const pass of [
			(e) => e.important,
			related,
			() => true
		]) {
			for (let i = events.length - 1; i >= 0; i--) {
				const e = events[i];
				if (picked.has(e) || e.text.length + 1 > left || !pass(e)) continue;
				picked.add(e);
				left -= e.text.length + 1;
			}
		}
		return {
			text: events.filter((e) => picked.has(e)).map((e) => e.text).join("\n"),
			source: used,
			total: events.length,
			used: picked.size
		};
	}
	async function parseCbs(text) {
		if (!text || !String(text).includes("{{")) return String(text || "");
		try {
			return await risuai.parseRisuChat(String(text), { rmVar: true });
		} catch {
			return String(text);
		}
	}
	const normalize = (s) => String(s || "").toLowerCase().replace(/[\s_\-.·・()\[\]]/g, "");

//#endregion
//#region src/data/lore-assets.js
	const isHiddenLore = (e) => /^__|ASSET_MAID/.test(String(e.comment || "")) || !e.content;
	function loreTitle(entry) {
		return String(entry.comment || String(entry.key || "").split(",")[0] || "").trim();
	}
	async function loreBooks() {
		let books = [];
		try {
			books = (await risuai.getCurrentLorebookEntries() || []).filter((e) => !isHiddenLore(e));
		} catch {
			books = [];
		}
		const self = botSelf;
		if (self?.name && self.desc.trim() && !books.some((e) => normalize(loreTitle(e)) === normalize(self.name))) {
			books = [...books, {
				comment: self.name,
				key: [self.name, self.nickname].filter(Boolean).join(","),
				content: self.desc,
				botDescription: true
			}];
		}
		return books;
	}
	const NOT_IMAGE = /\.(mp3|wav|ogg|m4a|flac|mp4|webm|mov|txt|json)$/i;
	const EXPLICIT_ASSET = /(^|[^a-z])(sex|cum|anal|oral|nude|naked|nsfw|hentai|ahegao|aroused|rape|porn)([^a-z]|$)|sex|cowgirl|doggy|fellatio|blowjob|handjob|hand job|fingering|fullnelson|full nelson|missionary|paizuri|titjob|masturbat|creampie|bukkake|orgasm|pussy|penis|nipple|vagina|breast|🔞|섹스|야스|알몸|나체|자위|삽입|펠라|가슴|성행위/i;
	function isImageAsset(asset) {
		return asset[1] && !String(asset[0]).includes("__am__") && !EXPLICIT_ASSET.test(String(asset[0])) && !NOT_IMAGE.test(String(asset[1])) && !NOT_IMAGE.test(String(asset[0])) && !/^(mp3|wav|ogg|mp4|webm)$/i.test(String(asset[2] || ""));
	}
	function assetList(char) {
		const list = [];
		for (const a of char.additionalAssets || []) if (isImageAsset(a)) list.push({
			name: String(a[0]),
			path: a[1]
		});
		for (const a of char.emotionImages || []) if (isImageAsset(a)) list.push({
			name: String(a[0]),
			path: a[1]
		});
		return list;
	}
	const defaultModuleIds = (ctx) => [...new Set([...ctx.char.modules || [], ...ctx.chat.modules || []])];
	async function readJson(key) {
		try {
			const raw = await risuai.pluginStorage.getItem(key);
			return typeof raw === "string" ? JSON.parse(raw) : raw;
		} catch (error) {
			if (key !== DEBUG_KEY && key !== SYSTEM_KEY) {
				const event = await systemStart("load");
				await systemEnd(event, "failed", error);
			}
			return null;
		}
	}
	async function readModules() {
		const db = await risuai.getDatabase(["modules"]);
		return db?.modules || [];
	}
	async function gatherAssets(ctx, refresh = false) {
		const key = ASSET_CACHE + ctx.char.chaId;
		const cache = await readJson(key) || {};
		const ids = cache.selected || defaultModuleIds(ctx);
		const signature = ids.slice().sort().join(",");
		let fromModules = !refresh && cache.signature === signature ? cache.list : null;
		if (!fromModules) {
			fromModules = [];
			if (ids.length) {
				try {
					const wanted = new Set(ids);
					for (const mod of await readModules()) {
						if (!wanted.has(mod.id)) continue;
						for (const a of mod.assets || []) if (isImageAsset(a)) fromModules.push({
							name: String(a[0]),
							path: a[1]
						});
					}
				} catch (e) {
					console.log("[interlude] module assets failed: " + e.message);
					void systemFailure("load", e, "module assets failed");
				}
			}
			await risuai.pluginStorage.setItem(key, JSON.stringify({
				...cache,
				signature,
				list: fromModules
			}));
		}
		const seen = new Set(), list = [];
		for (const a of [...assetList(ctx.char), ...fromModules]) if (!seen.has(a.path)) {
			seen.add(a.path);
			list.push(a);
		}
		view.assets = list;
		return list;
	}
	function assetPrefixes(assets) {
		const seen = new Set();
		for (const a of assets) seen.add(a.name.split(/[._\s]/)[0]);
		return [...seen].filter(Boolean);
	}
	const NEUTRAL_ASSET = /(default|neutral|normal|profile|portrait|idle|basic|기본|평상|프로필)/i;
	const PLEASANT_ASSET = /(smile|happy|joyful|cute|casual|미소|웃음)/i;
	const HARSH_ASSET = /(angry|crazy|evil|forced|enraged|sad|cry|tears|depress|disgust|contempt|jealous|annoy|guilty|exhaust|dead|blood|injur|미친|분노|울음)/i;
	function portraitScore(name) {
		let score = 0;
		if (NEUTRAL_ASSET.test(name)) score += 100;
		if (PLEASANT_ASSET.test(name)) score += 30;
		if (HARSH_ASSET.test(name)) score -= 50;
		return score;
	}
	const ROMAJI_SYLLABLES = {
		시: ["shi", "si"],
		치: ["chi", "ti"],
		츠: ["tsu", "tu"],
		즈: ["zu", "ju"],
		후: ["fu", "hu"],
		지: ["ji", "zi"],
		슈: ["shu", "su"],
		쇼: ["sho", "so"],
		샤: ["sha", "sa"],
		추: ["chu", "tsu"],
		주: ["ju", "zu"],
		자: ["ja", "za"],
		조: ["jo", "zo"],
		제: ["je", "ze"]
	};
	const ROMAJI_ONSET = [
		["g", "k"],
		["kk"],
		["n"],
		["d", "t"],
		["tt"],
		["r", "l"],
		["m"],
		["b", "p"],
		["pp"],
		["s"],
		["ss"],
		[""],
		["j", "z"],
		["jj"],
		["ch", "t"],
		["k"],
		["t"],
		["p"],
		["h"]
	];
	const ROMAJI_VOWEL = [
		["a"],
		["e", "ae"],
		["ya"],
		["ye"],
		[
			"eo",
			"o",
			"u"
		],
		["e"],
		["yeo", "yo"],
		["ye"],
		["o"],
		["wa"],
		["wae"],
		["oe", "we"],
		["yo"],
		["u"],
		["wo"],
		["we"],
		["wi"],
		["yu"],
		["eu", "u"],
		["ui"],
		["i"]
	];
	const ROMAJI_CODA = {
		1: ["k"],
		4: ["n"],
		7: ["t"],
		8: ["r", "l"],
		16: ["m"],
		17: ["p"],
		19: ["t"],
		21: ["ng", "n"]
	};
	function romajiVariants(name) {
		let results = [""];
		for (const ch of String(name)) {
			const code = ch.charCodeAt(0) - 44032;
			if (code < 0 || code > 11171) return [];
			const coda = code % 28, vowel = Math.floor(code / 28) % 21, onset = Math.floor(code / 588);
			let options = ROMAJI_SYLLABLES[ch];
			if (!options) {
				options = [];
				for (const o of ROMAJI_ONSET[onset]) for (const v of ROMAJI_VOWEL[vowel]) for (const c of coda ? ROMAJI_CODA[coda] || [""] : [""]) options.push(o + v + c);
			}
			const next = [];
			for (const r of results) for (const o of options) if (next.length < 64) next.push(r + o);
			results = next;
		}
		return results;
	}
	function contactFullNames(contact) {
		const lore = String(contact.lore || "");
		const loreNames = [lore.replace(/\s*[（(].*?[）)]\s*$/, ""), ...[...lore.matchAll(/[（(]([^）)]+)[）)]/g)].map((m) => m[1])].filter(Boolean);
		const names = [
			contact.name,
			...loreNames,
			...contact.aliases || []
		].filter((n) => typeof n === "string" && n.trim());
		const compound = names.some((n) => /[\s_]/.test(n.trim()));
		const full = names.filter((n) => /[\s_]/.test(n.trim()) || !compound || n === contact.name && (!loreNames.some((l) => /[\s_]/.test(l.trim())) || loreNames.some((l) => normalize(l) === normalize(n))));
		return full;
	}
	function contactNeedles(contact, reversed = false) {
		const full = contactFullNames(contact).flatMap((n) => {
			if (!reversed) return [n];
			const parts = n.trim().split(/[\s_]+/);
			return parts.length === 2 ? [parts.reverse().join(" ")] : [];
		});
		const needles = [...full, ...full.flatMap((n) => romajiVariants(n.replace(/[\s_-]/g, "")))].map(normalize).filter((n) => n.length >= 2);
		return [...new Set(needles)];
	}
	function assetPersonName(name) {
		const stem = String(name).replace(/\.(png|jpe?g|webp|gif|avif)$/i, "").split(".")[0];
		return stem.split(/(?:_|\s)+(?:default|neutral|normal|profile|portrait|idle|basic|smile|happy|sad|angry|casual|school_uniform)(?=$|[_\s])/i)[0];
	}
	const assetRomajiKey = (name) => normalize(name).replace(/ou|oo/g, "o").replace(/uu/g, "u");
	const assetIndexes = new WeakMap();
	function assetIndex(assets) {
		let index = assetIndexes.get(assets);
		if (!index) {
			index = {
				exact: new Map(),
				roman: new Map()
			};
			for (const a of assets) {
				if (String(a.name).includes("__am__")) continue;
				const prefix = normalize(assetPersonName(a.name));
				if (!prefix) continue;
				if (!index.exact.has(prefix)) index.exact.set(prefix, []);
				index.exact.get(prefix).push(a);
				const roman = assetRomajiKey(prefix);
				if (!index.roman.has(roman)) index.roman.set(roman, new Set());
				index.roman.get(roman).add(prefix);
			}
			assetIndexes.set(assets, index);
		}
		return index;
	}
	function assetPeople(people) {
		if (people) return people;
		const state = typeof view !== "undefined" ? states.get(view.key) : null;
		return [...state?.candidates || [], ...state?.contacts || []];
	}
	function rankedAssets(contact, assets, people) {
		const index = assetIndex(assets), needles = contactNeedles(contact);
		const reverse = contactNeedles(contact, true);
		const catalog = assetPeople(people);
		const ownerKey = (c) => typeof resolvedPersonKey === "function" ? resolvedPersonKey(c, catalog) : c.loreId || normalize(c.lore || c.name);
		const ownKey = ownerKey(contact);
		const inferredAllowed = (key) => !catalog.some((c) => ownerKey(c) !== ownKey && contactNeedles(c).includes(key));
		const identities = new Set();
		for (const needle of needles) {
			if (index.exact.has(needle)) identities.add(needle);
		}
		if (!identities.size) {
			const swapped = new Set(reverse.filter((n) => index.exact.has(n) && inferredAllowed(n)));
			if (swapped.size === 1) identities.add([...swapped][0]);
		}
		if (!identities.size) {
			const roman = new Set();
			for (const needle of [...needles, ...reverse]) for (const key of index.roman.get(assetRomajiKey(needle)) || []) if (inferredAllowed(key)) roman.add(key);
			if (roman.size === 1) identities.add([...roman][0]);
		}
		if (!identities.size) {
			const aliases = [
				...contact.aliases || [],
				...contact.keys || [],
				...String(contact.name || "").split(/\s+/)
			].filter((n) => typeof n === "string").map(normalize).filter((n) => n.length >= 2);
			const weak = new Set();
			for (const alias of aliases) {
				if (!index.exact.has(alias)) continue;
				const owners = new Set(catalog.filter((c) => [
					c.name,
					...c.aliases || [],
					...c.keys || [],
					...String(c.name || "").split(/\s+/)
				].some((n) => normalize(n) === alias)).map(ownerKey));
				if (owners.size > 1 || owners.size === 1 && !owners.has(ownKey)) continue;
				weak.add(alias);
			}
			if (weak.size === 1) identities.add([...weak][0]);
		}
		const hits = [...identities].flatMap((key) => index.exact.get(key) || []);
		return hits.slice().sort((x, y) => portraitScore(y.name) - portraitScore(x.name) || x.name.length - y.name.length);
	}
	const pickAsset = (contact, assets, people) => rankedAssets(contact, assets, people)[0]?.path || "";
	function repairAutoImages(state, assets) {
		if (!assets.length) return 0;
		let changed = 0;
		const people = [...state.candidates || [], ...state.contacts];
		for (const contact of state.contacts) {
			if (contact.manualImage) continue;
			const ranked = rankedAssets(contact, assets, people);
			if (ranked.some((a) => a.path === contact.image)) continue;
			const next = ranked[0]?.path || "";
			if (next !== (contact.image || "")) {
				contact.image = next;
				changed++;
			}
		}
		return changed;
	}
	const imageUrls = new Map();
	async function imageUrl(path) {
		if (!path) return "";
		if (path.startsWith("data:")) return path;
		if (imageUrls.has(path)) return imageUrls.get(path);
		let url = "";
		try {
			const data = await risuai.readImage(path);
			if (data) url = URL.createObjectURL(new Blob([data]));
		} catch (e) {
			console.log("[interlude] image failed: " + e.message);
			void systemFailure("photo", e, "image failed");
		}
		imageUrls.set(path, url);
		return url;
	}

//#endregion
//#region src/model/llm.js
	async function readStream(stream, diagnostic) {
		const reader = stream.getReader();
		let text = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return text;
				if (typeof value === "string") text += value;
				else if (value && typeof value === "object") text = String(Object.values(value)[0] ?? text);
				if (diagnostic) {
					diagnostic.chunks = (diagnostic.chunks || 0) + 1;
					diagnostic.raw = text;
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
	async function askModel(messages, diagnostic, purpose = "model", usage = []) {
		const request = messages.map((m) => `[${m.role}]\n${m.content || ""}`).join("\n\n");
		const event = await systemStart(purpose, {
			request,
			parentId: diagnostic?.id || "",
			purpose,
			contextUsage: diagnostic?.contextUsage || usage
		});
		const trace = diagnostic || {};
		let failure;
		try {
			return await runModelRequest(messages, trace);
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			for (const key of [
				"raw",
				"rawChars",
				"processedChars",
				"chunks",
				"slot",
				"phase",
				"responseType"
			]) if (trace[key] !== undefined) event[key] = trace[key];
			await systemEnd(event, failure ? "failed" : "success", failure);
		}
	}
	async function runModelRequest(messages, diagnostic) {
		const slot = String(await risuai.getArgument("model_slot") || "").trim();
		if (diagnostic) {
			diagnostic.slot = slot === "main" ? "main" : "aux";
			diagnostic.phase = "model";
			diagnostic.promptSizes = messages.map((m) => ({
				role: m.role,
				chars: String(m.content || "").length
			}));
		}
		messages = messages.map((m, i) => i === 0 ? {
			...m,
			content: m.content + OWN_MARK
		} : m);
		const res = await risuai.runLLMModel({
			mode: slot === "main" ? "model" : "otherAx",
			messages,
			allowPlugins: true
		});
		if (diagnostic) diagnostic.responseType = String(res?.type || "missing");
		if (!res || res.type === "fail") throw new Error(String(res && res.result || "모델 응답 없음").slice(0, 200));
		const text = res.type === "streaming" ? await readStream(res.result, diagnostic) : Array.isArray(res.result) ? String(res.result[0]?.[1] ?? res.result[0] ?? "") : String(res.result ?? "");
		const cleaned = text.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?\s*>/gi, "").replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/gi, "").trim();
		if (diagnostic) {
			diagnostic.raw = text;
			diagnostic.rawChars = text.length;
			diagnostic.processedChars = cleaned.length;
			diagnostic.thinkingRemoved = text.trim() !== cleaned;
		}
		return cleaned;
	}

//#endregion
//#region src/people/find.js
	async function inPool(items, size, job, onEach) {
		const queue = items.slice();
		await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
			while (queue.length) {
				const item = queue.shift();
				await job(item);
				onEach?.();
			}
		}));
	}
	function parseLines(text) {
		return text.split("\n").map((l) => l.replace(/^[\s\-*•\d.)`]+/, "").trim()).filter((l) => l.includes("|")).map((l) => l.split("|").map((p) => p.trim().replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, "").replace(/^(출력|이름|답변?|결과)\s*[:：]\s*/, "")));
	}
	const splitNames = (s) => String(s || "").split(/[,，、/]/).map((x) => x.trim()).filter(Boolean);
	const baseTitle = (title) => title.split(/\s[-–—]\s/)[0].trim();
	function personKey(person) {
		if (person.loreId) return "lore-id:" + person.loreId;
		return person.lore ? "lore:" + normalize(person.lore) : "name:" + normalize(person.name);
	}
	function resolvedPersonKey(person, people) {
		if (person.lore || person.loreId) return personKey(person);
		const matches = (people || []).filter((c) => (c.lore || c.loreId) && [c.name, ...c.aliases || []].some((n) => normalize(n) === normalize(person.name)));
		const keys = new Set(matches.map(personKey));
		return keys.size === 1 ? [...keys][0] : personKey(person);
	}
	function existingPersonKeys(state) {
		const people = [...state.candidates || [], ...state.contacts];
		return new Set(state.contacts.map((c) => resolvedPersonKey(c, people)));
	}
	function dedupeCandidates(candidates) {
		const found = new Map();
		const sourced = (candidates || []).filter((c) => c?.lore);
		for (const candidate of candidates || []) {
			if (!candidate || typeof candidate.name !== "string" || !candidate.name.trim()) continue;
			let resolved = candidate;
			if (!candidate.lore && !candidate.loreId) {
				const matches = sourced.filter((c) => [c.name, ...c.aliases || []].some((n) => normalize(n) === normalize(candidate.name)));
				const keys = new Set(matches.map(personKey));
				if (keys.size === 1) resolved = {
					...candidate,
					lore: matches[0].lore,
					loreId: matches[0].loreId
				};
			}
			const key = personKey(resolved), existing = found.get(key);
			if (existing) {
				existing.aliases = [...new Set([
					...existing.aliases || [],
					candidate.name,
					...candidate.aliases || []
				])].filter((a) => normalize(a) !== normalize(existing.name));
				if (!existing.asset && candidate.asset) existing.asset = candidate.asset;
				existing.keys = [...new Set([...existing.keys || [], ...candidate.keys || []])];
			} else {
				found.set(key, {
					...resolved,
					aliases: [...candidate.aliases || []],
					keys: [...candidate.keys || []]
				});
			}
		}
		return [...found.values()];
	}
	function appearanceText(text) {
		return String(text || "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/?[a-z][^>]*>/gi, " ").replace(/\{\{[\s\S]*?\}\}/g, " ").replace(/&(?:[a-z]+|#\d+|#x[a-f0-9]+);/gi, " ").replace(/\s+/g, " ").trim();
	}
	function mentionEvidence(person, story, people) {
		const text = appearanceText(story);
		if (!text) return null;
		const names = [...new Set([person.name, ...person.aliases || []].filter((n) => typeof n === "string" && n.trim().length >= 2))];
		const identity = resolvedPersonKey(person, people);
		for (const name of names) {
			const token = name.trim();
			if (normalize(token) !== normalize(person.name) && token.replace(/\s/g, "").length < 3) continue;
			const owners = new Set((people || []).filter((c) => [c.name, ...c.aliases || []].some((n) => normalize(n) === normalize(token))).map((c) => resolvedPersonKey(c, people)));
			if (owners.size > 1 || owners.size === 1 && !owners.has(identity)) continue;
			const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
			const particle = "(?:은|는|이|가|을|를|와|과|의|도|만|에게|한테|랑|하고|에서|야|아|씨|님)";
			const match = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}]|${particle}(?=$|[^\\p{L}\\p{N}]))`, "iu").exec(text);
			if (match) return {
				name: token,
				excerpt: text.slice(Math.max(0, match.index - 22), Math.min(text.length, match.index + match[0].length + 42))
			};
		}
		return null;
	}
	const NOT_A_PERSON = /템플릿|template|양식|예시|샘플|sample/i;
	async function scanCandidatesRaw(ctx, state, onProgress) {
		const books = await loreBooks();
		const assets = await gatherAssets(ctx);
		const titles = new Map();
		for (const entry of books) {
			const title = loreTitle(entry);
			const base = baseTitle(title);
			if (base && !titles.has(normalize(base))) titles.set(normalize(base), {
				title: base,
				keys: String(entry.key || "").split(",").map((k) => k.trim()).filter(Boolean).slice(0, 4)
			});
		}
		const lines = [...titles.values()].map((t) => `${t.title} | ${t.keys.join(", ")}`);
		const batches = [];
		for (let i = 0; i < lines.length; i += SCAN_BATCH) batches.push(lines.slice(i, i + SCAN_BATCH));
		const found = new Map();
		const add = (name, aliases, lore, asset) => {
			name = String(name || "").trim();
			if (!name || name.length > 24) return;
			const known = lore && titles.get(normalize(baseTitle(lore)));
			const key = personKey({
				name,
				lore: known?.title || ""
			});
			const item = found.get(key) || {
				name,
				aliases: [],
				lore: "",
				asset: "",
				keys: []
			};
			item.aliases = [...new Set([
				...item.aliases,
				name,
				...aliases
			])].filter((a) => normalize(a) !== normalize(item.name));
			if (known && !item.lore) {
				item.lore = known.title;
				item.keys = known.keys;
			}
			if (asset && !item.asset) item.asset = asset;
			found.set(key, item);
		};
		let failed = 0, firstError = "", done = 0;
		const total = batches.length + 1;
		const report = () => onProgress?.(++done, total);
		await inPool(batches, 3, async (batch) => {
			if (view.scanJob?.stop) return;
			const prompt = `아래는 RP 로어북 항목 목록이다. 각 줄은 "제목 | 키워드"다. 이 중 사람만 고른다.
규칙:
- 메신저로 대화할 수 있는 인물만 고른다. 사람이 아니어도 말을 하는 존재면 포함한다.
- 장소, 조직, 사건, 아이템, 규칙, 시스템, 설정 항목, 템플릿은 고르지 않는다. 이름 없이 직책만 있는 항목도 고르지 않는다. 주인공 ${view.me?.name || ""}도 고르지 않는다.
- 빠뜨리지 않는다. 목록에 있는 인물은 모두 쓴다.
- 설명 없이 한 줄에 한 명씩 다음 형식으로만 출력한다:
이름|다른 이름들(쉼표로 구분)|로어 제목

[목록]
${batch.join("\n")}`;
			try {
				for (const [name, aliases, lore] of parseLines(await askModel([{
					role: "user",
					content: prompt
				}], null, "scan"))) add(name, splitNames(aliases), lore || name);
			} catch (e) {
				failed++;
				firstError ||= e.message;
			}
		}, report);
		const story = (await storyWindow(ctx, 8e3)).text;
		if (story.length > 200 && !view.scanJob?.stop) {
			try {
				const reply = await askModel([{
					role: "user",
					content: `아래 줄거리에서 이름이 나오는 사람 중 [이미 찾은 인물]에 없는 사람만 쓴다. 주인공 ${view.me?.name || ""}은 쓰지 않는다. 없으면 "없음"이라고만 쓴다.
설명 없이 한 줄에 한 명씩 다음 형식으로만 출력한다:
이름|다른 이름들(쉼표로 구분)

[이미 찾은 인물]
${[...found.values()].map((f) => f.name).join(", ").slice(0, 6e3)}

[줄거리]
${story}`
				}], null, "scan");
				for (const [name, aliases] of parseLines(reply)) add(name, splitNames(aliases));
			} catch (e) {
				failed++;
				firstError ||= e.message;
			}
		}
		report();
		if (found.size < 3 && assets.length && !view.scanJob?.stop) {
			try {
				const reply = await askModel([{
					role: "user",
					content: `아래는 이미지 에셋 이름 목록이다. 이 중 사람 이름인 것만 고른다. 버튼, 배경, 로고 같은 것은 고르지 않는다.
설명 없이 한 줄에 한 명씩 다음 형식으로만 출력한다:
한글 이름|다른 이름들(쉼표로 구분)|에셋 이름

[에셋 이름]
${assetPrefixes(assets).join(", ").slice(0, 8e3)}`
				}], null, "scan");
				for (const [name, aliases, asset] of parseLines(reply)) add(name, splitNames(aliases), "", asset);
			} catch (e) {
				failed++;
				firstError ||= e.message;
			}
		}
		const me = normalize(view.me?.name);
		state.candidates = dedupeCandidates([...state.candidates || [], ...found.values()].filter((c) => normalize(c.name) !== me && !NOT_A_PERSON.test(c.name)));
		state.scannedAt = Date.now();
		state.scannedMessages = (ctx.chat.message || []).length;
		return {
			count: state.candidates.length,
			failed,
			firstError,
			cancelled: !!view.scanJob?.stop
		};
	}
	const scanCandidates = systemInstrument("scan", scanCandidatesRaw, (r) => ({
		status: r.cancelled ? "cancelled" : r.failed ? "partial" : "success",
		error: r.firstError
	}));

//#endregion
//#region src/core/storage.js
	const states = new Map();
	async function getContext() {
		const charIndex = await risuai.getCurrentCharacterIndex();
		const chatIndex = await risuai.getCurrentChatIndex();
		const char = await risuai.getCharacterFromIndex(charIndex);
		const chat = await risuai.getChatFromIndex(charIndex, chatIndex);
		if (!char || !chat) return null;
		const key = STORE_PREFIX + char.chaId + ":" + (chat.id || "idx" + chatIndex);
		if (chat.id) botOfChat.set(chat.id, char.chaId);
		botSelf = {
			name: char.name || "",
			nickname: char.nickname || "",
			desc: char.desc || ""
		};
		return {
			charIndex,
			chatIndex,
			char,
			chat,
			key
		};
	}
	const botOfChat = new Map();
	async function currentPlace() {
		const charIndex = await risuai.getCurrentCharacterIndex();
		if (!(charIndex >= 0)) return null;
		const chatIndex = await risuai.getCurrentChatIndex();
		const chat = await risuai.getChatFromIndex(charIndex, chatIndex);
		if (!chat) return null;
		const chaId = chat.id ? botOfChat.get(chat.id) : undefined;
		if (!chaId) {
			const ctx = await getContext();
			return ctx && {
				key: ctx.key,
				charIndex: ctx.charIndex,
				chatIndex: ctx.chatIndex,
				chat: ctx.chat
			};
		}
		return {
			key: STORE_PREFIX + chaId + ":" + chat.id,
			charIndex,
			chatIndex,
			chat
		};
	}
	let botSelf = null;
	async function loadState(key) {
		if (states.has(key)) return states.get(key);
		const event = await systemStart("load");
		let state = null;
		try {
			const raw = await risuai.pluginStorage.getItem(key);
			state = typeof raw === "string" ? JSON.parse(raw) : raw;
			await systemEnd(event);
		} catch (e) {
			await systemEnd(event, "failed", e);
			console.log("[interlude] load failed: " + e.message);
		}
		const fresh = !state;
		state = state || {
			enabled: false,
			inject: true,
			contacts: [],
			rooms: [],
			scannedAt: 0
		};
		if (fresh) {
			state.follow = Object.fromEntries(Object.keys(BOT_CARDS).map((card) => [card, true]));
			state.memoryIntro = "bot";
		} else if (!state.follow || typeof state.follow !== "object") state.follow = {};
		if (Array.isArray(state.candidates)) state.candidates = dedupeCandidates(state.candidates);
		state.useSummary ??= true;
		state.storyIn ??= true;
		state.storySource ??= "auto";
		state.memoryOn ??= false;
		state.newMemory ??= false;
		applyBotCfg(state, await loadBotCfg(botIdOf(key)));
		for (const room of state.rooms || []) for (const m of room.msgs || []) {
			if (m.photo?.state === "pending") Object.assign(m.photo, {
				state: "failed",
				error: "사진을 그리는 중에 중단됐어요."
			});
		}
		states.set(key, state);
		return state;
	}
	async function saveStateRaw(key) {
		const state = states.get(key);
		if (state) await risuai.pluginStorage.setItem(key, JSON.stringify(state));
	}
	const saveState = systemInstrument("storage", saveStateRaw);

//#endregion
//#region src/core/time.js
	const TIME_MODES = {
		off: {
			label: "끄기",
			desc: "시간 정보를 따로 넣지 않아요. 줄거리 속 상태창의 시각은 메신저 시간 판단에 쓰지 않아요."
		},
		real: {
			label: "실시간",
			desc: "기기의 현재 시각과 메시지 사이에 실제로 흐른 시간을 알려 줘요."
		},
		session: {
			label: "세션 시간",
			desc: "본편 상태창의 날짜·시각을 메신저의 지금으로 써요. 그 시점을 넘기지 않아요."
		}
	};
	const TIME_SOURCES = [
		["auto", "자동"],
		["var", "채팅 변수"],
		["pick", "상태창에서 고르기"]
	];
	const SESSION_LOOKBACK = 5;
	const EMPTY_TIME = /^(?:|-|–|—|\?{1,3}|n\/?a|none|unknown|없음|불명|모름)$/i;
	const MONTHS = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
	const DATE_RE = new RegExp(`(?<!\\d)(?:\\d{4}[.\\-/]\\d{1,2}[.\\-/]\\d{1,2}|\\d{4}년\\s*\\d{1,2}월\\s*\\d{1,2}일|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})(?!\\d)(?:\\s*\\([^)]{1,6}\\))?`, "gi");
	const DATE_ONE = new RegExp(DATE_RE.source, "i");
	const TIME_LABEL_RE = /(?:^|[\s|[*•-])(?:time|시간|시각)\s*[:：]\s*([^|\]\n,]+)/gi;
	function statusLine(line) {
		const t = line.trim();
		if (!t || /^[("“「‘']/.test(t)) return false;
		return /[[\]|]/.test(t) || /(?:^|[\s*•-])(?:date|time|날짜|시간|시각)\s*[:：]/i.test(t) || /^[^\p{L}\p{N}\s]/u.test(t);
	}
	function timeField(value) {
		const raw = String(value || "").replace(/^\s*(?:time|시간|시각)\s*[:：]\s*/i, "").trim();
		if (EMPTY_TIME.test(raw)) return "";
		const t = raw.replace(/[^\p{L}\p{N}~:.\s-]/gu, " ").replace(/\s+/g, " ").trim();
		if (EMPTY_TIME.test(t)) return "";
		return t.length > 30 ? t.slice(0, 30) + "…" : t;
	}
	function freeTime(text) {
		const m = [...String(text).matchAll(DATE_RE)].pop();
		if (!m) return null;
		const rest = text.slice(m.index + m[0].length);
		const sep = rest.match(/^\s*(?:[|,·/]\s*)?(?:[-*•]\s*)?(?:time|시간|시각)\s*[:：]\s*/i) || rest.match(/^\s*[|,·]\s*/) || rest.match(/^[ \t]+(?=\d{1,2}\s*:\s*\d{2})/);
		return {
			date: m[0].trim(),
			time: sep ? timeField(rest.slice(sep[0].length).split(/\s\/\s|[|\]\n,·]/)[0]) : ""
		};
	}
	function autoTime(text) {
		const nu = [...text.matchAll(/\[Nu\|([^|\]\n]*)\|([^|\]\n]*)\|/g)].pop();
		if (nu) {
			const date = EMPTY_TIME.test(nu[1].trim()) ? "" : nu[1].trim(), time = timeField(nu[2]);
			if (date || time) return {
				date,
				time,
				source: "nu"
			};
		}
		const status = text.split("\n").filter(statusLine).join("\n");
		const label = [...status.matchAll(TIME_LABEL_RE)].map((x) => timeField(x[1])).filter(Boolean).pop() || "";
		const free = freeTime(status);
		if (free) return {
			date: free.date,
			time: free.time || label,
			source: "free"
		};
		return label ? {
			date: "",
			time: label,
			source: "label"
		} : null;
	}
	const lineFields = (line) => line.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, "").split(/\s*[|,·]\s*/).map((f) => f.trim()).filter(Boolean);
	const linePrefix = (line) => (lineFields(line)[0] || "").split(/\s+/)[0];
	function pickedTime(text, src) {
		const line = text.split("\n").filter((l) => l.trim() && linePrefix(l) === src.prefix).pop();
		if (!line) return null;
		const fields = lineFields(line), value = src.index < 0 ? fields.join(", ") : fields[src.index] || "";
		const free = DATE_ONE.test(value) ? freeTime(value) : null;
		const time = free ? free.time : timeField(value);
		return free?.date || time ? {
			date: free?.date || "",
			time,
			source: "pick"
		} : null;
	}
	function variableTime(chat, name) {
		const raw = chat?.scriptstate?.["$" + name];
		const value = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
		const free = freeTime(value);
		if (free) return {
			...free,
			source: "var",
			name
		};
		const time = timeField(value);
		return time ? {
			date: "",
			time,
			source: "var",
			name
		} : null;
	}
	function sessionTime(chat, src) {
		const kind = src?.kind || "auto";
		if (kind === "var") return src.var ? variableTime(chat, src.var) : null;
		if (kind === "pick" && !src.prefix) return null;
		const bots = (chat?.message || []).filter((m) => m.role === "char").slice(-SESSION_LOOKBACK).reverse();
		for (const [back, m] of bots.entries()) {
			const text = String(m.data || "");
			const found = kind === "pick" ? pickedTime(text, src) : autoTime(text);
			if (found) return {
				...found,
				back
			};
		}
		return null;
	}
	const stampText = (st) => [st?.date, st?.time].filter(Boolean).join(" ");
	const sessionStamp = (found) => found ? {
		date: found.date,
		time: found.time
	} : null;
	const WEEKDAYS_EN = {
		sun: "일",
		mon: "월",
		tue: "화",
		wed: "수",
		thu: "목",
		fri: "금",
		sat: "토"
	};
	const MONTH_NAMES = [
		"jan",
		"feb",
		"mar",
		"apr",
		"may",
		"jun",
		"jul",
		"aug",
		"sep",
		"oct",
		"nov",
		"dec"
	];
	function dateLabel(date) {
		const t = String(date || "").trim();
		let m = t.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/) || t.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
		let month = m ? +m[2] : 0, day = m ? +m[3] : 0;
		if (!m && (m = t.match(new RegExp(`(${MONTHS})\\.?\\s+(\\d{1,2})`, "i")))) {
			month = MONTH_NAMES.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
			day = +m[2];
		}
		if (!month) return t;
		const wd = t.match(/\(([^)]{1,6})\)/)?.[1].trim();
		const w = wd ? WEEKDAYS_EN[wd.slice(0, 3).toLowerCase()] || wd.replace(/요일$/, "") : "";
		return `${month}월 ${day}일${w ? ` (${w})` : ""}`;
	}
	const DAYPARTS = [
		[5, "새벽"],
		[9, "아침"],
		[12, "오전"],
		[14, "낮"],
		[18, "오후"],
		[21, "저녁"],
		[24, "밤"]
	];
	const TIME_WORDS = {
		"early morning": "이른 아침",
		"late night": "늦은 밤",
		dawn: "새벽",
		predawn: "새벽",
		morning: "아침",
		forenoon: "오전",
		noon: "정오",
		midday: "정오",
		daytime: "낮",
		afternoon: "오후",
		evening: "저녁",
		dusk: "저녁",
		sunset: "저녁",
		twilight: "저녁",
		night: "밤",
		midnight: "밤"
	};
	const TIME_MODIFIERS = {
		early: "이른",
		late: "늦은"
	};
	function timeLabel(time) {
		const t = String(time || "").trim();
		if (!t) return "";
		let hour = null, min = null;
		const clock = t.match(/(\d{1,2})\s*:\s*(\d{2})/);
		if (clock) {
			hour = +clock[1];
			min = +clock[2];
		} else {
			const h = t.match(/(\d{1,2})\s*(?:시|o'?clock|(?=\s*(?:am|pm|a\.m\.|p\.m\.)))/i);
			if (h) {
				hour = +h[1];
				const mm = t.match(/(\d{1,2})\s*분/);
				if (mm) min = +mm[1];
			}
		}
		if (hour !== null && hour < 24) {
			if (hour < 12 && /pm|p\.m\.|오후|저녁|밤/i.test(t)) hour += 12;
			else if (hour === 12 && /am|a\.m\.|오전|새벽/i.test(t)) hour = 0;
			return `${DAYPARTS.find(([end]) => hour < end)[1]} ${hour === 0 ? 0 : hour % 12 || 12}${min !== null ? ":" + String(min).padStart(2, "0") : "시"}`;
		}
		const word = Object.keys(TIME_WORDS).sort((a, b) => b.length - a.length).find((w) => new RegExp(`\\b${w}\\b`, "i").test(t));
		let out = t;
		if (word) out = t.replace(new RegExp(`\\b(?:(early|late)\\s+)?${word}\\b`, "i"), (_, mod) => (mod && !word.includes(" ") ? TIME_MODIFIERS[mod.toLowerCase()] + " " : "") + TIME_WORDS[word]).replace(/\s*,\s*/g, " ").replace(/\s+/g, " ").trim();
		return out.length > 20 ? out.slice(0, 20) + "…" : out;
	}
	function sessionLine(st, prev) {
		const date = st.date && (!prev || dateLabel(prev.date) !== dateLabel(st.date)) ? dateLabel(st.date) : "";
		return [date, timeLabel(st.time)].filter(Boolean).join(" ") || dateLabel(st.date);
	}
	function gapText(ms) {
		const min = ms / 6e4;
		if (min < 60) return `약 ${Math.max(10, Math.round(min / 10) * 10)}분`;
		if (min < 1440) return `약 ${Math.round(min / 60)}시간`;
		return `약 ${Math.round(min / 1440)}일`;
	}
	const REAL_GAP = 30 * 6e4;
	function realNow() {
		const d = new Date(), p = (n) => String(n).padStart(2, "0");
		return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${"일월화수목금토"[d.getDay()]}) ${p(d.getHours())}:${p(d.getMinutes())}`;
	}

//#endregion
//#region src/ui/floating-button.js
	const SIZE = 48;
	const EDGE = 8;
	const DRAG_FROM = 6;
	const PLACE_KEY = "interlude:fab-place:v1";
	const DEFAULT_PLACE = {
		x: 1,
		y: .2
	};
	let ready = null;
	let doc = null;
	let button = null;
	let onOpen = null;
	let place = { ...DEFAULT_PLACE };
	let visible = false;
	let html = "";
	let drag = null;
	const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
	const at = (share) => `calc(${EDGE}px + (100% - ${SIZE + EDGE * 2}px) * ${share})`;
	function style(left, top) {
		return [
			"position:fixed",
			"z-index:40",
			`width:${SIZE}px`,
			`height:${SIZE}px`,
			"padding:0",
			"margin:0",
			"border:0",
			"border-radius:14px",
			"background:transparent",
			"box-shadow:0 2px 10px rgba(0,0,0,.28)",
			"touch-action:none",
			"user-select:none",
			"-webkit-user-select:none",
			`cursor:${drag?.moved ? "grabbing" : "pointer"}`,
			"line-height:0",
			`display:${visible ? "block" : "none"}`,
			`left:${left}`,
			`top:${top}`
		].join(";");
	}
	let wanted = null;
	let applying = false;
	async function apply(left, top) {
		wanted = {
			left,
			top
		};
		if (applying) return;
		applying = true;
		try {
			while (wanted) {
				const w = wanted;
				wanted = null;
				await button.setStyleAttribute(style(w.left, w.top));
			}
		} finally {
			applying = false;
		}
	}
	const applyPlace = () => apply(at(place.x), at(place.y));
	async function loadPlace() {
		try {
			const saved = JSON.parse(await risuai.safeLocalStorage.getItem(PLACE_KEY) || "null");
			if (saved && typeof saved === "object") place = {
				x: clamp01(saved.x),
				y: clamp01(saved.y)
			};
		} catch {}
	}
	async function savePlace() {
		try {
			await risuai.safeLocalStorage.setItem(PLACE_KEY, JSON.stringify(place));
		} catch {}
	}
	async function create(open) {
		doc = await risuai.getRootDocument();
		if (!doc) return false;
		const old = await doc.querySelectorAll("[x-interlude-fab]");
		for (let i = 0, n = await old.length(); i < n; i++) await (await old.at(i))?.remove();
		await loadPlace();
		onOpen = open;
		button = await doc.createElement("button");
		await button.setAttribute("x-interlude-fab", "1");
		await applyPlace();
		const body = await doc.querySelector("body");
		if (!body) return false;
		await body.appendChild(button);
		await button.addEventListener("pointerdown", async (e) => {
			if (e.button !== undefined && e.button !== 0) return;
			const d = drag = {
				x0: e.clientX,
				y0: e.clientY,
				free: null,
				moved: false,
				left: 0,
				top: 0
			};
			const [w, h] = await Promise.all([doc.clientWidth(), doc.clientHeight()]);
			d.free = {
				x: Math.max(1, w - SIZE - EDGE * 2),
				y: Math.max(1, h - SIZE - EDGE * 2)
			};
			d.left0 = EDGE + d.free.x * place.x;
			d.top0 = EDGE + d.free.y * place.y;
		});
		await doc.addEventListener("pointermove", (e) => {
			if (!drag?.free) return;
			const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
			if (!drag.moved && Math.hypot(dx, dy) < DRAG_FROM) return;
			drag.moved = true;
			drag.left = Math.min(EDGE + drag.free.x, Math.max(EDGE, drag.left0 + dx));
			drag.top = Math.min(EDGE + drag.free.y, Math.max(EDGE, drag.top0 + dy));
			void apply(drag.left + "px", drag.top + "px");
		});
		const end = async (e) => {
			const d = drag;
			drag = null;
			if (!d) return;
			if (!d.moved) {
				if (e.type === "pointerup") onOpen?.();
				return;
			}
			place = {
				x: clamp01((d.left - EDGE) / d.free.x),
				y: clamp01((d.top - EDGE) / d.free.y)
			};
			await applyPlace();
			await savePlace();
		};
		await doc.addEventListener("pointerup", end);
		await doc.addEventListener("pointercancel", end);
		await button.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") onOpen?.();
		});
		return true;
	}
	function floatingButton(open) {
		ready ||= create(open).catch((e) => {
			console.log("[interlude] floating button failed: " + e.message);
			return false;
		});
		return ready;
	}
	async function showFloating(icon) {
		if (!button) return;
		if (icon !== html) {
			html = icon;
			await button.setInnerHTML(icon);
		}
		if (!visible) {
			visible = true;
			await applyPlace();
		}
	}
	async function hideFloating() {
		if (!button || !visible) return;
		visible = false;
		drag = null;
		await applyPlace();
	}

//#endregion
//#region src/ui/icons.js
	const ICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><defs><linearGradient id=\"c\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#FF5C87\"/><stop offset=\"1\" stop-color=\"#B5179E\"/></linearGradient></defs><rect x=\"2\" y=\"2\" width=\"60\" height=\"60\" rx=\"15\" fill=\"url(#c)\"/><rect x=\"9\" y=\"11\" width=\"46\" height=\"5\" rx=\"2.5\" fill=\"#fff\"/><path d=\"M12 16h19c0 13-5 24-14 29h-5zM52 16H33c0 13 5 24 14 29h5z\" fill=\"#fff\"/><rect x=\"11\" y=\"47\" width=\"42\" height=\"4\" rx=\"2\" fill=\"#fff\" opacity=\".85\"/></svg>";
	const ICON_URI = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(ICON_SVG);

//#endregion
//#region src/ui/screens/photos.js
	function photoRatio(p) {
		const [w, h2] = p?.w && p?.h ? [p.w, p.h] : PHOTO_SIZES[imageCfg.size] || PHOTO_SIZES.portrait;
		return `${w}/${h2}`;
	}
	function thumbButton(item, onclick, cls = "ph") {
		const btn = h("button", {
			class: cls,
			style: cls === "ph" ? `aspect-ratio:${photoRatio(item.msg.photo)}` : null,
			"aria-label": "사진 크게 보기",
			"data-t": cls === "ph" ? "photo-msg" : "gallery-item",
			onclick
		});
		lazily(btn, () => photoThumb(item.msg.photo.id).then((url) => {
			btn.append(url ? h("img", {
				src: url,
				alt: "",
				decoding: "async"
			}) : h("span", { class: "ph-note" }, "사진을 불러오지 못했어요"));
		}));
		return btn;
	}
	function photoBubble(room, m) {
		const p = m.photo;
		if (p.state === "done" && p.id) return thumbButton({
			room,
			msg: m
		}, () => openViewer([{
			room,
			msg: m
		}], 0));
		if (p.state === "pending") return h("div", {
			class: "ph ph-wait",
			style: `aspect-ratio:${photoRatio(p)}`,
			role: "status",
			"data-t": "photo-pending"
		}, h("span", { class: "spin" }), "사진 보내는 중…");
		if (p.state === "deleted") return h("div", {
			class: "ph ph-wait small",
			"data-t": "photo-deleted"
		}, "삭제한 사진");
		return h("div", {
			class: "ph ph-wait small",
			"data-t": "photo-failed"
		}, "사진을 받지 못했어요", p.error ? h("small", {}, p.error) : null, h("button", {
			class: "pill",
			"data-t": "photo-retry",
			disabled: !imageReady(),
			onclick: () => queuePhoto(view.key, room.id, m.id)
		}, "다시 그리기"));
	}
	function openViewer(items, index) {
		view.viewer = {
			items,
			index,
			full: "",
			fullId: ""
		};
		render();
	}
	function closeViewer() {
		view.viewer = null;
		render();
	}
	function stamp(t) {
		const d = new Date(t), p = (n) => String(n).padStart(2, "0");
		return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
	}
	function photoFileName(state, item, n = 0) {
		const who = state.contacts.find((c) => c.id === item.msg.from)?.name || "photo";
		return `${who}-${stamp(item.msg.t)}${n ? "-" + n : ""}.webp`.replace(/[\\/:*?"<>|]/g, "_");
	}
	function dataUrlBytes(url) {
		const bin = atob(String(url).slice(String(url).indexOf(",") + 1));
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}
	function saveBlob(name, blob) {
		const url = URL.createObjectURL(blob);
		const a = h("a", {
			href: url,
			download: name
		});
		document.body.append(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1e4);
	}
	const CRC_TABLE = (() => {
		const t = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
			t[n] = c >>> 0;
		}
		return t;
	})();
	function crc32(bytes) {
		let c = 4294967295;
		for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ c >>> 8;
		return (c ^ 4294967295) >>> 0;
	}
	function makeZip(files) {
		const enc = new TextEncoder(), parts = [], central = [];
		let offset = 0;
		for (const f of files) {
			const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
			const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
			lv.setUint32(0, 67324752, true);
			lv.setUint16(4, 20, true);
			lv.setUint16(6, 2048, true);
			lv.setUint16(12, 33, true);
			lv.setUint32(14, crc, true);
			lv.setUint32(18, size, true);
			lv.setUint32(22, size, true);
			lv.setUint16(26, name.length, true);
			local.set(name, 30);
			const cen = new Uint8Array(46 + name.length), cv = new DataView(cen.buffer);
			cv.setUint32(0, 33639248, true);
			cv.setUint16(4, 20, true);
			cv.setUint16(6, 20, true);
			cv.setUint16(8, 2048, true);
			cv.setUint16(14, 33, true);
			cv.setUint32(16, crc, true);
			cv.setUint32(20, size, true);
			cv.setUint32(24, size, true);
			cv.setUint16(28, name.length, true);
			cv.setUint32(42, offset, true);
			cen.set(name, 46);
			parts.push(local, f.data);
			central.push(cen);
			offset += local.length + size;
		}
		const end = new Uint8Array(22), ev = new DataView(end.buffer);
		ev.setUint32(0, 101010256, true);
		ev.setUint16(8, files.length, true);
		ev.setUint16(10, files.length, true);
		ev.setUint32(12, central.reduce((n, c) => n + c.length, 0), true);
		ev.setUint32(16, offset, true);
		return new Blob([
			...parts,
			...central,
			end
		], { type: "application/zip" });
	}
	async function downloadPhotos(state, items, btn) {
		if (view.zipping) return;
		view.zipping = true;
		try {
			const files = [], names = new Set();
			for (let i = 0; i < items.length; i++) {
				if (btn) btn.textContent = `저장 준비 중 ${i + 1}/${items.length}`;
				const url = await photoFull(items[i].msg.photo.id);
				if (!url) continue;
				let name = photoFileName(state, items[i]);
				for (let n = 2; names.has(name); n++) name = photoFileName(state, items[i], n);
				names.add(name);
				files.push({
					name,
					data: dataUrlBytes(url)
				});
			}
			if (files.length) saveBlob(`interlude-${view.ctx?.chat?.name || "photos"}-${stamp(Date.now())}.zip`.replace(/[\\/:*?"<>|]/g, "_"), makeZip(files));
			view.notice = files.length ? `사진 ${files.length}장을 ZIP으로 저장했어요.` : "저장할 사진을 불러오지 못했어요.";
		} finally {
			view.zipping = false;
			render();
		}
	}
	async function deletePhotoMessage(item) {
		const id = item.msg.photo?.id;
		if (item.profileOf) item.profileOf.profileShots = (item.profileOf.profileShots || []).filter((s) => s.id !== id);
		else item.msg.photo = {
			...item.msg.photo,
			state: "deleted",
			id: ""
		};
		await deletePhotoData(id);
		await saveState(view.key);
	}
	async function usePhotoAsProfile(state, item, url) {
		const contact = item.profileOf || state.contacts.find((c) => c.id === item.msg.from);
		if (!contact) return;
		const key = view.key, source = url || await photoFull(item.msg.photo.id);
		if (view.key !== key || !source) return;
		const crop = await editProfileCrop(source, contact.imageCrop);
		if (!crop || view.key !== key) return;
		const old = {
			image: contact.image,
			imageCrop: contact.imageCrop,
			manualImage: contact.manualImage
		};
		Object.assign(contact, {
			image: source,
			imageCrop: crop,
			manualImage: true
		});
		try {
			await saveState(key);
		} catch {
			Object.assign(contact, old);
			view.notice = "프로필 사진을 저장하지 못했어요.";
			return;
		}
		view.notice = `${contact.name}의 프로필 사진을 바꿨어요.`;
	}
	function photoGenerationDetails(photo) {
		const g = photo.generation;
		const field = (label, value) => h("div", {}, h("strong", {}, label), h("pre", {}, value || "(없음)"));
		if (g?.schema === 1) return h("div", { "data-t": "photo-used-tags" }, field("모델 · 크기 · 시드", `${g.model} · ${g.width}×${g.height} · ${g.seed}`), field("공통 태그 (그림체 + 장면)", g.base), ...(g.chars || []).map((tags, i) => field(`인물 태그 · ${g.people?.[i]?.name || i + 1}`, tags)), field("네거티브 태그", g.negative), ...(g.charNegatives || []).map((tags, i) => tags ? field(`인물 네거티브 · ${g.people?.[i]?.name || i + 1}`, tags) : null).filter(Boolean), ...g.avoidCovering?.length ? [field("모델이 선택한 가림 억제 태그 (적용됨)", g.avoidCovering.join(", "))] : []);
		return h("div", { "data-t": "photo-used-tags-missing" }, h("p", {}, "이전 사진에는 실제 생성에 사용한 전체 태그가 저장되어 있지 않아요. 아래는 메시지에 남아 있는 요청 태그예요."), field("요청 장면 태그", photo.tags), field("요청 의상 태그", photoOutfit(photo)));
	}
	async function savePhotoPrompt(key, roomId, msgId, photoId, draft) {
		const state = states.get(key), room = state?.rooms.find((r) => r.id === roomId);
		const msg = room?.msgs.find((m) => m.id === msgId), photo = msg?.photo;
		const ctx = await currentPlace();
		if (!ctx || ctx.key !== key || !state?.enabled || !state.rooms.includes(room) || !room.msgs.includes(msg) || !photo || photo.id !== photoId || photo.state !== "done") throw new Error("사진 상태가 바뀌어 프롬프트를 저장하지 않았어요.");
		if (!draft || draft.schema !== 1 || typeof draft.base !== "string" || !draft.base.trim() || draft.base.length > 2e4 || !Array.isArray(draft.chars) || draft.chars.length !== photo.generation?.chars?.length || draft.chars.some((t) => typeof t !== "string" || t.length > 4e3) || typeof draft.negative !== "string" || draft.negative.length > 1e4) throw new Error("프롬프트 형식이나 길이를 확인해 주세요.");
		const previous = photo.promptOverride;
		const source = previous || photo.generation;
		const charNegatives = draft.charNegatives === undefined ? source.charNegatives : draft.charNegatives;
		if (charNegatives !== undefined && (!Array.isArray(charNegatives) || charNegatives.length !== draft.chars.length || charNegatives.some((t) => typeof t !== "string" || t.length > 4e3))) throw new Error("인물 네거티브 형식이나 길이를 확인해 주세요.");
		const kept = new Set(imagePromptTags(draft.negative, []));
		const choices = selectedCovering(source.avoidCovering).filter((t) => kept.has(t));
		const added = selectedCovering(source.coveringAdded).filter((t) => kept.has(t));
		const base = draft.base.trim(), chars = draft.chars.map((t) => t.trim());
		const wanted = coveringAuto(base, chars, "").added;
		const before = coveringAuto(source.base || "", source.chars || [], "").added;
		const sourceNegative = new Set(String(source.negative || "").split(",").map((t) => t.trim()));
		const autoBefore = new Set(source.autoCovering || before.filter((t) => sourceNegative.has(t)));
		let negative = draft.negative.split(",").map((t) => t.trim()).filter((t) => t && !(autoBefore.has(t) && !wanted.includes(t))).join(", ");
		if (!before.length && wanted.length) negative = coveringAuto(base, chars, negative).negative;
		const present = new Set(negative.split(",").map((t) => t.trim()));
		const choice = coveringChoicePrompt(base, chars, negative, choices, added);
		photo.promptOverride = {
			...photo.generation,
			edited: true,
			base,
			chars,
			negative: choice.negative,
			...Array.isArray(charNegatives) ? { charNegatives: charNegatives.map((t) => t.trim()) } : {},
			autoCovering: wanted.filter((t) => present.has(t)),
			avoidCovering: choice.avoidCovering,
			coveringAdded: choice.coveringAdded
		};
		try {
			await saveState(key);
		} catch (e) {
			if (previous === undefined) delete photo.promptOverride;
			else photo.promptOverride = previous;
			throw e;
		}
	}
	async function redrawViewedPhoto(item, v) {
		if (v.redrawing || v.editPrompt?.saving) return;
		const key = view.key;
		v.redrawing = true;
		v.error = "";
		v.connectionError = false;
		render();
		try {
			await loadImageCfg();
			if (!imageReady()) {
				v.connectionError = true;
				throw new Error("NovelAI 연결이 필요해요. 설정 → 사진에서 사진 기능을, 설정 → 시작 준비에서 API 키를 확인해 주세요.");
			}
			const ctx = await currentPlace(), state = states.get(key);
			if (!ctx || ctx.key !== key || !item.room || !state?.rooms.includes(item.room) || !item.room.msgs.includes(item.msg) || item.msg.photo?.state !== "done") throw new Error("사진 상태가 바뀌어 다시 생성하지 않았어요.");
			if (v.editPrompt) {
				await savePhotoPrompt(key, item.room.id, item.msg.id, item.msg.photo.id, v.editPrompt);
				v.editPrompt = null;
			}
			queuePhoto(key, item.room.id, item.msg.id);
			if (view.viewer === v) closeViewer();
		} catch (e) {
			v.error = e.message;
		} finally {
			v.redrawing = false;
			if (view.viewer === v) render();
		}
	}
	function photoPromptEditor(item, v) {
		const photo = item.msg.photo, key = view.key;
		if (!item.room || photo.generation?.schema !== 1) return h("p", {}, "실제 생성 태그가 저장된 대화 사진에서 프롬프트를 수정할 수 있어요.");
		if (!v.editPrompt) return h("div", {}, v.promptNotice ? h("p", { "data-t": "prompt-saved" }, v.promptNotice) : null, photo.promptOverride ? h("p", {}, "수정 프롬프트가 저장되어 있어요. 다시 그리기에 적용됩니다.") : null, h("button", {
			class: "pill",
			"data-t": "prompt-edit",
			onclick: () => {
				v.editPrompt = JSON.parse(JSON.stringify(photo.promptOverride || photo.generation));
				v.promptNotice = "";
				render();
			}
		}, "프롬프트 수정"));
		const draft = v.editPrompt;
		const field = (label, value, id, change) => {
			const input = h("textarea", {
				rows: 3,
				"data-t": id,
				"aria-label": label,
				disabled: !!draft.saving
			}, value);
			input.addEventListener("input", () => change(input.value));
			return h("label", { class: "prompt-field" }, h("span", {}, label), input);
		};
		const save = async (regenerate) => {
			if (draft.saving) return;
			draft.saving = true;
			draft.error = "";
			render();
			try {
				await savePhotoPrompt(key, item.room.id, item.msg.id, photo.id, draft);
				if (view.viewer !== v) return;
				v.editPrompt = null;
				v.promptNotice = "저장했어요. 수정값은 다음 다시 그리기에 적용됩니다.";
				if (regenerate) await redrawViewedPhoto(item, v);
				else render();
			} catch (e) {
				draft.error = e.message;
				draft.saving = false;
				if (view.viewer === v) render();
			}
		};
		return h("div", { "data-t": "prompt-editor" }, h("p", {}, "공통·인물별 태그와 공통·인물별 네거티브를 수정해 다시 그립니다. 인물 네거티브를 빈칸으로 저장하면 해당 인물의 네거티브를 지웁니다. 저장만 하면 현재 사진은 바뀌지 않아요. 기존 모델·크기를 유지하고 시드는 새로 선택합니다."), h("p", {
			class: "sub",
			"data-t": "prompt-covering-note"
		}, "네거티브의 가림 태그(towel, robe, steam censor 등)를 지우면 다시 그릴 때도 빠진 채로 그립니다."), field("공통 태그", draft.base, "prompt-base", (value) => {
			draft.base = value;
		}), ...draft.chars.map((tags, i) => field(`인물 태그 · ${photo.generation.people?.[i]?.name || i + 1}`, tags, "prompt-char-" + i, (value) => {
			draft.chars[i] = value;
		})), field("네거티브 태그", draft.negative, "prompt-negative", (value) => {
			draft.negative = value;
		}), ...draft.chars.map((_, i) => field(`인물 네거티브 · ${photo.generation.people?.[i]?.name || i + 1}`, draft.charNegatives?.[i] || "", "prompt-char-negative-" + i, (value) => {
			if (!Array.isArray(draft.charNegatives)) draft.charNegatives = draft.chars.map(() => "");
			draft.charNegatives[i] = value;
		})), draft.error ? h("p", { "data-t": "prompt-error" }, draft.error) : null, h("div", { class: "actions" }, h("button", {
			class: "pill",
			"data-t": "prompt-save",
			disabled: !!draft.saving,
			onclick: () => save(false)
		}, "저장"), h("button", {
			class: "pill primary",
			"data-t": "prompt-save-redraw",
			disabled: !!draft.saving || !!v.redrawing,
			onclick: () => save(true)
		}, "저장하고 다시 생성"), h("button", {
			class: "pill",
			"data-t": "prompt-cancel",
			disabled: !!draft.saving,
			onclick: () => {
				v.editPrompt = null;
				render();
			}
		}, "취소")));
	}
	function viewerOverlay(state) {
		const v = view.viewer;
		const item = v?.items[v.index];
		if (!item || item.msg.photo?.state !== "done") {
			view.viewer = null;
			return null;
		}
		const sender = state.contacts.find((c) => c.id === item.msg.from);
		const img = h("img", {
			alt: "",
			"data-t": "viewer-img"
		});
		if (v.fullId === item.msg.photo.id && v.full) img.src = v.full;
		else {
			photoThumb(item.msg.photo.id).then((url) => {
				if (url && !img.getAttribute("src")) img.src = url;
			});
			photoFull(item.msg.photo.id).then((url) => {
				if (!url || view.viewer !== v) return;
				v.full = url;
				v.fullId = item.msg.photo.id;
				img.src = url;
			});
		}
		const move = (d) => {
			if (v.editPrompt?.saving) return;
			v.index = (v.index + d + v.items.length) % v.items.length;
			v.full = "";
			v.fullId = "";
			v.editPrompt = null;
			v.promptNotice = "";
			render();
		};
		const del = h("button", {
			class: "vbtn",
			"data-t": "viewer-delete",
			onclick: async () => {
				if (!del.dataset.armed) {
					del.dataset.armed = "1";
					del.lastChild.textContent = "한 번 더";
					return;
				}
				await deletePhotoMessage(item);
				v.items.splice(v.index, 1);
				if (!v.items.length) {
					closeViewer();
					return;
				}
				v.index = Math.min(v.index, v.items.length - 1);
				v.full = "";
				v.fullId = "";
				render();
			}
		}, icon("trash", 22), h("span", {}, "삭제"));
		const many = v.items.length > 1;
		return h("div", {
			class: "viewer",
			role: "dialog",
			"aria-label": "사진",
			"data-t": "viewer"
		}, h("div", { class: "vtop" }, h("button", {
			class: "plain light",
			"aria-label": "닫기",
			"data-t": "viewer-close",
			onclick: closeViewer
		}, icon("close", 22)), h("span", { class: "mid" }, h("span", { class: "nm" }, sender?.name || ""), h("span", { class: "st" }, `${new Date(item.msg.t).toLocaleString()}${many ? ` · ${v.index + 1}/${v.items.length}` : ""}`))), h("div", { class: "vbody" }, img, many ? h("button", {
			class: "vnav l",
			"aria-label": "이전 사진",
			"data-t": "viewer-prev",
			onclick: () => move(-1)
		}, icon("prev", 28)) : null, many ? h("button", {
			class: "vnav r",
			"aria-label": "다음 사진",
			"data-t": "viewer-next",
			onclick: () => move(1)
		}, icon("next", 28)) : null), item.msg.text ? h("div", { class: "vcap" }, item.msg.text) : null, v.error ? h("div", {
			class: "vcap",
			role: "alert",
			"data-t": "viewer-error"
		}, v.error, v.connectionError ? h("button", {
			class: "pill",
			"data-t": "viewer-setup",
			onclick: () => go(imageCfg.enabled ? "set-setup" : "set-photo")
		}, "사진 설정 열기") : null) : null, h("details", {
			class: "vdetails",
			"data-t": "photo-details",
			open: !!v.editPrompt || !!v.promptNotice
		}, h("summary", {}, "이미지 상세 · 사용 태그"), photoGenerationDetails(item.msg.photo), photoPromptEditor(item, v)), h("div", { class: "vacts" }, h("button", {
			class: "vbtn",
			"data-t": "viewer-download",
			onclick: async () => {
				const url = v.fullId === item.msg.photo.id && v.full ? v.full : await photoFull(item.msg.photo.id);
				if (url) saveBlob(photoFileName(state, item), new Blob([dataUrlBytes(url)], { type: "image/webp" }));
			}
		}, icon("download", 22), h("span", {}, "저장")), item.room ? h("button", {
			class: "vbtn",
			"data-t": "viewer-redraw",
			disabled: !!v.redrawing || !!v.editPrompt?.saving,
			onclick: () => redrawViewedPhoto(item, v)
		}, icon("refresh", 22), h("span", {}, "다시 그리기")) : null, sender ? h("button", {
			class: "vbtn",
			"data-t": "viewer-profile",
			onclick: async () => {
				await usePhotoAsProfile(state, item, v.fullId === item.msg.photo.id ? v.full : "");
				closeViewer();
			}
		}, avatar(sender, 22), h("span", {}, "프로필로")) : null, del));
	}
	function galleryBody(state) {
		const all = photosOf(state);
		const people = state.contacts.filter((c) => all.some((x) => x.msg.from === c.id || (x.msg.photo.who || []).includes(c.id)));
		const who = people.some((c) => c.id === view.galleryWho) ? view.galleryWho : "";
		const list = who ? photosOf(state, who) : all;
		const body = h("div", {
			class: "scroll",
			id: "scroll"
		});
		if (view.notice) body.append(h("div", {
			class: "notice",
			"data-t": "notice"
		}, view.notice));
		if (!all.length) {
			body.append(h("div", { class: "hello" }, h("div", {
				class: "meta",
				"data-t": "gallery-empty"
			}, imageReady() ? "아직 받은 사진이 없어요." : "설정 → 시작 준비에서 NovelAI를 연결하면 인물이 사진을 보낼 수 있어요."), imageReady() ? null : h("button", {
				class: "pill",
				"data-t": "gallery-setup",
				onclick: () => go(imageCfg.enabled ? "set-setup" : "set-photo")
			}, "사진 설정")));
			return body;
		}
		const chip = (id, label) => h("button", {
			class: "pill" + (who === id ? " primary" : ""),
			"data-t": "gallery-filter",
			"data-name": label,
			onclick: () => {
				view.galleryWho = id;
				render();
			}
		}, label);
		const zip = h("button", {
			class: "pill",
			"data-t": "gallery-zip",
			disabled: !!view.zipping,
			onclick: () => downloadPhotos(state, list, zip)
		}, `ZIP으로 저장 (${list.length}장)`);
		body.append(h("div", { class: "chips" }, chip("", "전체"), people.map((c) => chip(c.id, c.name))), h("div", { class: "actions" }, zip), h("div", {
			class: "gal",
			"data-t": "gallery"
		}, list.map((item, i) => thumbButton(item, () => openViewer(list.slice(), i), "gitem"))));
		return body;
	}

//#endregion
//#region src/ui/syslog-screen.js
	async function openSystemLog() {
		mountUi();
		view.open = true;
		view.screen = "system-log";
		await risuai.showContainer("fullscreen");
		await systemWait(systemQueue);
		await systemLoad();
		render();
		await systemEnvironmentRefresh();
		if (view.screen === "system-log") render();
	}
	function systemVisible() {
		return (systemRows || []).filter((e) => (!view.systemKind || e.kind === view.systemKind) && (!view.systemStatus || (view.systemStatus === "errors" ? [
			"failed",
			"partial",
			"interrupted"
		].includes(e.status) : e.status === view.systemStatus)));
	}
	function systemScreen() {
		const rows = systemVisible(), all = systemRows || [];
		const select = (field, label, options) => h("label", { class: "field" }, label, h("select", {
			"data-t": field,
			onchange: (ev) => {
				view[field] = ev.target.value;
				render();
			}
		}, options.map(([value, text]) => h("option", {
			value,
			selected: (view[field] || "") === value
		}, text))));
		const copy = async (entries) => {
			await copyText(JSON.stringify(systemExport(true, entries), null, 2));
			render();
		};
		return [h("div", { class: "top line-b" }, view.key ? backBtn(() => go("set-manage")) : null, h("h1", { class: "small" }, "시스템 로그"), closeBtn()), h("div", {
			class: "scroll",
			id: "scroll"
		}, h("div", { class: "notice" }, "Interlude 작업을 최근 최대 200건까지 기록합니다. 저장 용량 한도에 따라 오래된 기록은 먼저 지워집니다. 원문 포함 복사에는 요청·응답의 대화와 설정 내용이 들어갈 수 있습니다. 개발자에게 자동 전송하지 않습니다."), h("div", { class: "notice" }, "버그 문의: ", h("a", { href: "mailto:pkindwide@proton.me" }, "pkindwide@proton.me"), " · 사용한 모델명·추론 설정과 시스템 로그를 함께 보내 주세요."), systemStorageError ? h("div", {
			class: "notice",
			role: "alert",
			"data-t": "system-storage-error"
		}, "시스템 로그 저장 또는 읽기에 실패했습니다. 현재 메모리의 기록은 복사할 수 있습니다.") : null, view.notice ? h("div", {
			class: "notice",
			role: "status"
		}, view.notice) : null, h("div", { class: "actions" }, h("button", {
			class: "pill",
			"data-t": "system-refresh",
			onclick: async () => {
				await systemWait(systemQueue);
				await systemEnvironmentRefresh();
				render();
			}
		}, "새로고침"), h("button", {
			class: "pill",
			"data-t": "system-copy-all",
			onclick: () => copy(all)
		}, `전체 ${all.length}건 복사 (원문 포함)`), h("button", {
			class: "pill",
			"data-t": "system-export-summary",
			onclick: () => downloadJson("interlude-system-summary.json", systemExport(false))
		}, "요약 로그 저장"), h("button", {
			class: "pill",
			"data-t": "system-export-full",
			onclick: () => downloadJson("interlude-system-log.json", systemExport(true))
		}, "원문 포함 로그 저장"), armedPill("로그 비우기", "한 번 더 누르면 비움", async () => {
			await systemClear();
			render();
		}, "system-clear")), h("details", {
			class: "card",
			"data-t": "system-environment"
		}, h("summary", { class: "analysis-summary" }, "앱·플러그인 환경 정보"), h("p", { class: "sub" }, "현재 조회 시점의 설치 목록입니다. 과거 요청 당시의 목록이 아닙니다. 앱 버전은 API에서 제공하지 않아 확인 불가이며, API 버전과 별개입니다. 다른 플러그인의 내부 요청은 수집하지 않습니다."), h("pre", { class: "debug-raw" }, JSON.stringify(systemEnvironment || { pluginsStatus: "조회 중" }, null, 2))), select("systemKind", "작업 종류", [["", "모든 작업"], ...Object.entries(SYSTEM_KINDS)]), select("systemStatus", "결과", [
			["", "모든 결과"],
			["errors", "오류만"],
			...Object.entries(SYSTEM_STATUS)
		]), h("div", { class: "actions" }, h("span", {
			class: "sub",
			"data-t": "system-count"
		}, `${rows.length}건 표시 / 전체 ${all.length}건`), h("button", {
			class: "pill",
			"data-t": "system-copy-visible",
			onclick: () => copy(rows)
		}, "표시된 기록 복사")), !rows.length ? h("div", {
			class: "hello",
			"data-t": "system-empty"
		}, "표시할 시스템 로그가 없어요.") : null, rows.map((e) => h("section", {
			class: "card",
			"data-t": "system-entry",
			"data-kind": e.kind,
			"data-status": e.status
		}, h("h3", {}, `${SYSTEM_KINDS[e.kind]}${e.purpose ? " · 모델 요청" : ""}`, h("small", {}, new Date(e.t).toLocaleString())), h("div", { class: [
			"failed",
			"partial",
			"interrupted"
		].includes(e.status) ? "debug-bad" : "debug-ok" }, `${SYSTEM_STATUS[e.status]} · ${e.durationMs ?? "?"}ms · ${e.id}`), e.error ? h("div", { class: "debug-bad" }, e.error) : null, h("details", {}, h("summary", { class: "analysis-summary" }, "처리 정보"), h("pre", { class: "debug-raw" }, JSON.stringify(systemExport(false, [e]).entries[0], null, 2))), h("details", {}, h("summary", { class: "analysis-summary" }, "요청·응답 원문"), h("pre", { class: "debug-raw" }, `요청${e.requestTruncated ? " (일부 생략)" : ""}\n${e.request || "(미수집)"}\n\n응답${e.rawTruncated ? " (일부 생략)" : ""}\n${e.raw || "(없음)"}\n\n${e.reasons.map((r) => r.why).join("\n")}`)), h("button", {
			class: "pill",
			"data-t": "system-copy-one",
			onclick: () => copy([e])
		}, "이 기록 복사"))))];
	}
	async function openDebug() {
		await debugQueue;
		await loadDebugLog();
		go("debug", {
			debugFrom: view.screen === "room" ? "room" : "set-manage",
			notice: ""
		});
	}
	function debugText(e) {
		return JSON.stringify(debugExport([e], true), null, 2);
	}
	function debugMeta(e) {
		const phases = {
			context: "채팅 확인",
			prompt: "요청 준비",
			model: "모델 호출",
			"context-check": "응답 후 채팅 확인",
			parse: "답장 해석",
			delivery: "대화 저장",
			complete: "완료"
		};
		const modes = {
			json: "JSON",
			"recovered-json": "앞부분 설명 뒤 JSON 복구",
			"recovery-rejected": "최종 답장 확인 불가",
			tagged: "이름: 답장 형식"
		};
		return [
			`Interlude ${e.version || "이전 버전"} · 기록 ID: ${e.id || "(이전 기록)"}`,
			`호출 슬롯: ${e.slot || "확인 불가"} · 실제 모델명/추론 설정: 확인 불가 (호스트에서 제공하지 않음)`,
			`단계: ${phases[e.phase] || "이전 기록"} · 소요: ${Number.isFinite(e.durationMs) ? (e.durationMs / 1e3).toFixed(2) + "초" : "확인 불가"}`,
			`응답 형태: ${e.responseType || "확인 불가"} · 스트림 조각: ${e.chunks ?? 0}`,
			`원문 ${e.rawChars ?? e.raw?.length ?? 0}자 → 분석 태그 처리 후 ${e.processedChars ?? "?"}자 · 읽기: ${modes[e.parseMode] || "확인 불가"}`,
			`유효 답장 ${e.accepted ?? 0}개 · 저장 완료 ${e.delivered ?? "?"}개`,
			`요청 길이: ${(e.promptSizes || []).map((m) => `${m.role} ${m.chars}자`).join(", ") || "이전 기록"}`,
			e.rawTruncated ? "긴 원문은 중간을 생략하고 앞뒤를 보존했습니다." : ""
		].filter(Boolean).join("\n");
	}
	function debugScreen() {
		const log = debugLog || [];
		return [h("div", { class: "top line-b" }, backBtn(() => go(view.debugFrom === "room" ? "room" : "set-manage")), h("h1", { class: "small" }, "답장 진단 기록"), closeBtn()), h("div", {
			class: "scroll",
			id: "scroll"
		}, h("div", { class: "notice" }, "최근 답장 30개를 모든 챗에서 모아 Interlude 저장소에 보관합니다. 개발자에게 자동 전송하지 않습니다. 요약 로그에는 대화 내용이 없고, 원문 포함 로그에는 보낸 메시지·응답·봇과 방 이름이 들어갑니다. 공유 전에 내용을 확인해 주세요."), debugStorageError ? h("div", {
			class: "notice",
			role: "alert",
			"data-t": "debug-storage-error"
		}, "진단 기록 저장 또는 삭제에 실패했습니다. 현재 보이는 기록을 내보내서 보관할 수 있습니다.") : null, view.notice ? h("div", {
			class: "notice",
			role: "status"
		}, view.notice) : null, log.length ? h("div", { class: "actions" }, h("button", {
			class: "pill",
			"data-t": "debug-copy-all",
			onclick: async () => {
				await copyText(JSON.stringify(debugExport(log, true), null, 2));
				render();
			}
		}, `전체 ${log.length}건 복사 (원문 포함)`), h("button", {
			class: "pill",
			"data-t": "debug-export-summary",
			onclick: () => downloadJson("interlude-diagnostics-summary.json", debugExport(log, false))
		}, "요약 로그 저장"), h("button", {
			class: "pill",
			"data-t": "debug-export-full",
			onclick: () => downloadJson("interlude-diagnostics-with-text.json", debugExport(log, true))
		}, "원문 포함 로그 저장"), armedPill("기록 비우기", "한 번 더 누르면 비움", async () => {
			await clearDebugLog();
			render();
		}, "debug-clear")) : h("div", { class: "hello" }, h("div", {
			class: "meta",
			"data-t": "debug-empty"
		}, "아직 기록이 없어요.")), log.map((e, n) => h("section", {
			class: "card" + (n ? "" : " first"),
			"data-t": "debug-entry"
		}, h("h3", {}, `${e.room}`, h("small", {}, new Date(e.t).toLocaleString())), h("div", { class: "sub" }, `${e.bot} · 보낸 메시지: ${e.sent || "(없음)"}`), h("div", {
			class: e.error ? "debug-bad" : "debug-ok",
			"data-t": "debug-result"
		}, e.error || `메시지 ${e.accepted}개 받음`), h("details", {}, h("summary", { class: "analysis-summary" }, "처리 정보 보기"), h("pre", {
			class: "debug-raw",
			"data-t": "debug-meta"
		}, debugMeta(e))), e.reasons.length ? h("ul", {
			class: "debug-reasons",
			"data-t": "debug-reasons"
		}, e.reasons.map((r) => h("li", {}, `${r.i >= 0 ? `${r.i + 1}번째 메시지: ` : ""}${r.why}`))) : null, h("details", {}, h("summary", { class: "analysis-summary" }, "받은 원문 보기 (추론 포함)"), h("pre", {
			class: "debug-raw",
			"data-t": "debug-raw"
		}, e.raw || "(응답 없음)")), h("div", { class: "actions flush" }, h("button", {
			class: "pill",
			"data-t": "debug-copy",
			onclick: async () => {
				await copyText(debugText(e));
				render();
			}
		}, "이 기록 복사 (원문 포함)")))))];
	}
	function jobBar() {
		const running = view.termJob ? {
			job: view.termJob,
			id: "terms-job",
			text: "단어 사전 만드는 중…"
		} : view.analysis ? {
			job: view.analysis,
			id: "analysis",
			text: `${view.analysis.label || "분석본 만드는 중"} ${view.analysis.done}/${view.analysis.total}`
		} : view.scanning && view.scanJob ? {
			job: view.scanJob,
			id: "scanning",
			text: `인물 찾는 중… ${view.scanProgress || ""}`
		} : null;
		if (!running) return null;
		const { job } = running;
		const a = running.id === "analysis" ? job : null;
		const now = a?.current?.size ? [...a.current].join(", ") : "";
		const pct = a?.total ? Math.round(a.done / a.total * 100) : 0;
		const mid = a ? h("span", { class: "mid" }, h("span", { class: "jobtext" }, running.text, now ? h("span", { "data-t": "job-now" }, ` · 지금: ${now}`) : null, a.failed ? h("span", {
			class: "jobfail",
			"data-t": "job-failed"
		}, ` · 실패 ${a.failed}`) : null), h("span", {
			class: "jobprog",
			role: "progressbar",
			"aria-valuemin": "0",
			"aria-valuemax": String(a.total),
			"aria-valuenow": String(a.done),
			"data-t": "job-progress"
		}, h("i", { style: `width:${pct}%` }))) : h("span", { class: "mid" }, running.text);
		return h("div", {
			class: "jobbar",
			id: "jobbar",
			"data-t": running.id,
			role: "status"
		}, mid, h("button", {
			class: "pill",
			"data-t": "job-stop",
			disabled: job.stop,
			onclick: () => {
				job.stop = true;
				refreshJobBar();
			}
		}, job.stop ? "멈추는 중…" : "멈추기"));
	}
	function refreshJobBar() {
		const win = document.getElementById("win");
		if (!win || !view.open) return;
		document.getElementById("jobbar")?.remove();
		const bar = jobBar();
		if (bar && win.firstElementChild) win.firstElementChild.after(bar);
	}

//#endregion
//#region src/ui/screens/picker.js
	async function startScan() {
		const ctx = view.ctx, key = view.key, state = states.get(key);
		view.scanning = true;
		view.notice = "";
		view.scanProgress = "";
		const job = view.scanJob = { stop: false };
		render();
		try {
			const result = await scanCandidates(ctx, state, (done, total) => {
				view.scanProgress = `${done}/${total}`;
				refreshJobBar();
			});
			await saveState(key);
			view.pickSelected = null;
			view.notice = job.stop ? `찾기를 멈췄어요. 지금까지 찾은 ${result.count}명을 보여드려요. 나머지는 다시 찾기로 찾을 수 있어요.` : result.count ? result.failed ? `후보 ${result.count}명을 찾았지만 일부 항목을 읽지 못했습니다. (${result.firstError || "모델 응답 오류"})` : "" : `인물 후보를 찾지 못했습니다.${result.firstError ? ` (${result.firstError})` : ""}`;
		} finally {
			view.scanning = false;
			render();
		}
	}
	function openPicker() {
		const state = states.get(view.key);
		go("pick", {
			pickQuery: "",
			pickSelected: null,
			pickTitles: null
		});
		if (!state.candidates && !view.scanning) startScan();
		loreBooks().then((books) => {
			view.pickTitles = [...new Set(books.map((e) => baseTitle(loreTitle(e))).filter(Boolean))];
			if (view.screen === "pick") render();
		}).catch(() => {});
	}
	function pickerList(state) {
		return dedupeCandidates([...state.candidates || [], ...state.contacts]);
	}
	function pickerSelection(state) {
		if (!view.pickSelected) {
			view.pickSelected = new Set();
		}
		return view.pickSelected;
	}
	function pickScreen(state) {
		const selected = pickerSelection(state);
		const has = existingPersonKeys({
			...state,
			contacts: state.contacts.filter(hasAnalyzedProfile)
		});
		const list = pickerList(state);
		const q = normalize(view.pickQuery);
		const shown = list.filter((c) => !q || normalize(c.name).includes(q) || (c.aliases || []).some((a) => normalize(a).includes(q)));
		const open = shown.filter((c) => !has.has(personKey(c)));
		const costText = (n) => `분석에 입력 약 ${(n * ANALYSIS_TOKENS).toLocaleString()}토큰이 들어요.`;
		const addBtn = h("button", {
			class: "pill primary",
			"data-t": "pick-add",
			disabled: !selected.size || !!view.analysis || !!view.bioBusy,
			onclick: () => {
				if (selected.size >= CONFIRM_FROM && !addBtn.dataset.armed) {
					addBtn.dataset.armed = "1";
					addBtn.textContent = "한 번 더 누르면 시작";
					return;
				}
				addPicked(state, selected);
			}
		}, `${selected.size}명 추가`);
		const cost = h("div", {
			class: "notice",
			"data-t": "pick-cost",
			hidden: !selected.size
		}, costText(selected.size));
		const assets = view.assets || assetList(view.ctx.char);
		const row = (c) => {
			const key = personKey(c), added = has.has(key);
			const preview = {
				...c,
				image: pickAsset(c, assets)
			};
			const evidence = mentionEvidence(c, view.storyText, list);
			return h("label", { class: "row pick" + (added ? " done" : "") }, avatar(preview, 44, inStory(c)), h("span", { class: "mid" }, h("span", { class: "nm" }, c.name), h("span", { class: "pv" }, h("span", { class: "tx" }, added ? "이미 추가됨" : state.contacts.some((x) => personKey(x) === key) ? "목록에 있음 · 분석이 필요해요" : c.lore ? `로어북: ${c.lore}` : "대화에서 찾은 후보")), evidence ? h("span", {
				class: "pv",
				"data-t": "name-evidence",
				title: evidence.excerpt
			}, h("span", { class: "tx" }, `이름 확인: ${evidence.excerpt}`)) : null), h("input", {
				type: "checkbox",
				checked: added || selected.has(key),
				disabled: added,
				"aria-label": `${c.name} 선택`,
				"data-t": "pick-item",
				"data-name": c.name,
				onchange: (e) => {
					if (e.target.checked) selected.add(key);
					else selected.delete(key);
					delete addBtn.dataset.armed;
					addBtn.textContent = `${selected.size}명 추가`;
					addBtn.disabled = !selected.size || !!view.analysis || !!view.bioBusy;
					cost.textContent = costText(selected.size);
					cost.hidden = !selected.size;
				}
			}), h("span", { class: "check" }));
		};
		const appeared = shown.filter(inStory), rest = shown.filter((c) => !inStory(c));
		const body = h("div", {
			class: "scroll",
			id: "scroll"
		});
		body.append(h("div", { class: "notice" }, "자동으로 선택하지 않아요. 최근 대화에서 이름이 확인된 후보도 실제 등장 여부를 확인하고 직접 골라 주세요."));
		if (view.notice) body.append(h("div", {
			class: "notice",
			"data-t": "notice"
		}, view.notice));
		body.append(cost);
		if (list.length) {
			body.append(h("div", { class: "actions" }, h("button", {
				class: "pill",
				"data-t": "pick-all",
				onclick: () => {
					for (const c of open) selected.add(personKey(c));
					render();
				}
			}, q ? "검색 결과 모두 선택" : "모두 선택"), h("button", {
				class: "pill",
				"data-t": "pick-none",
				onclick: () => {
					selected.clear();
					render();
				}
			}, "선택 해제"), h("button", {
				class: "pill",
				"data-t": "pick-rescan",
				disabled: view.scanning,
				onclick: startScan
			}, "다시 찾기")));
			if (appeared.length) body.append(h("div", { class: "sect" }, "최근 대화에서 이름 확인", h("small", {}, `${appeared.length}명`)), h("div", { class: "rows" }, appeared.map(row)));
			if (rest.length) body.append(h("div", { class: "sect" }, "로어북 인물", h("small", {}, `${rest.length}명`)), h("div", { class: "rows" }, rest.map(row)));
			const named = new Set(list.flatMap((c) => [
				c.name,
				c.lore,
				...c.aliases || []
			]).map(normalize).filter(Boolean));
			const others = (view.pickTitles || []).filter((t) => !named.has(normalize(t)) && (!q || normalize(t).includes(q)));
			if (others.length) body.append(h("details", {
				class: "others",
				"data-t": "pick-others",
				open: !!q
			}, h("summary", { class: "sect" }, "다른 로어 항목", h("small", {}, `${others.length}개 · 찾기에서 인물로 고르지 않은 항목`)), h("div", { class: "rows" }, others.map((t) => h("label", { class: "row pick" }, h("span", { class: "mid" }, h("span", { class: "nm" }, t), h("span", { class: "pv" }, h("span", { class: "tx" }, "체크하면 인물 후보로 추가해요"))), h("input", {
				type: "checkbox",
				"aria-label": `${t} 인물로 추가`,
				"data-t": "pick-other",
				"data-name": t,
				onchange: () => {
					const candidate = {
						name: t,
						aliases: [],
						lore: t,
						keys: []
					};
					state.candidates = dedupeCandidates([...state.candidates || [], candidate]);
					selected.add(personKey(candidate));
					render();
				}
			}), h("span", { class: "check" }))))));
			if (!shown.length) body.append(h("div", { class: "hello" }, h("div", { class: "meta" }, "찾는 인물이 없어요.")));
		} else if (!view.scanning) {
			body.append(h("div", { class: "hello" }, h("div", { class: "meta" }, "아직 후보가 없어요."), h("button", {
				class: "pill",
				"data-t": "pick-rescan",
				onclick: startScan
			}, "로어북에서 찾기")));
		}
		return [
			h("div", { class: "top line-b" }, backBtn(() => go("list", { tab: "people" })), h("h1", { class: "small" }, "인물 고르기"), addBtn),
			h("label", {
				class: "search",
				style: "margin-top:8px"
			}, icon("search", 16), h("input", {
				id: "pq",
				value: view.pickQuery || "",
				placeholder: "이름으로 찾기",
				"aria-label": "후보 검색",
				"data-t": "pick-search",
				oninput: (e) => {
					view.pickQuery = e.target.value;
					render(e.target);
				}
			})),
			body
		];
	}
	async function addPicked(state, selected) {
		if (view.analysis || view.bioBusy) return;
		const assets = view.assets || await gatherAssets(view.ctx);
		const has = existingPersonKeys({
			...state,
			contacts: state.contacts.filter(hasAnalyzedProfile)
		});
		const fresh = [];
		for (const c of pickerList(state)) {
			const key = personKey(c);
			if (!selected.has(key) || has.has(key)) continue;
			const people = [...state.candidates || [], ...state.contacts];
			const contact = state.contacts.find((old) => resolvedPersonKey(old, people) === key) || {
				id: newId(),
				name: c.name,
				aliases: c.aliases || [],
				keys: c.keys || [],
				lore: c.lore || "",
				loreId: c.loreId,
				asset: c.asset || "",
				role: "",
				image: "",
				manualImage: false
			};
			if (!contact.manualImage) contact.image = pickAsset(contact, assets);
			contact.manualAdd = true;
			has.add(key);
			fresh.push(contact);
		}
		state.removedNames = (state.removedNames || []).filter((n) => !fresh.some((c) => normalize(c.name) === n));
		selected.clear();
		await saveState(view.key);
		go("list", {
			tab: "people",
			notice: ""
		});
		await linkMissingAssets(state, fresh, assets);
		analyzeInBackground(state, fresh);
	}
	async function linkMissingAssets(state, contacts, assets) {
		if (repairAutoImages({
			contacts,
			candidates: [...state.candidates || [], ...state.contacts]
		}, assets)) {
			await saveState(view.key);
			render();
		}
	}
	async function analyzeInBackground(state, contacts, force = false) {
		if (view.bioBusy || view.analysis) {
			view.notice = "진행 중인 작업이 끝난 뒤 분석해 주세요.";
			render();
			return;
		}
		const seen = new Set();
		const people = [
			...state.candidates || [],
			...state.contacts,
			...contacts
		];
		contacts = contacts.filter((c) => {
			const key = resolvedPersonKey(c, people);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		const key = view.key;
		const ctx = view.ctx;
		const options = analysisOptions(ctx, force);
		if (!contacts.length) return;
		let joined = false;
		for (const c of contacts) {
			if (!c.manualAdd || state.contacts.some((x) => x.id === c.id)) continue;
			const people = [
				...state.candidates || [],
				...state.contacts,
				c
			], k = resolvedPersonKey(c, people);
			if (state.contacts.some((x) => resolvedPersonKey(x, people) === k)) continue;
			state.contacts.push(c);
			joined = true;
		}
		if (joined) await saveState(key);
		const job = {
			total: contacts.length,
			done: 0,
			failed: 0,
			reused: 0,
			stop: false,
			current: new Set(),
			failedIds: []
		};
		view.analysis = job;
		render();
		const books = await loreBooks();
		await inPool(contacts, 3, async (contact) => {
			if (job.stop) return;
			let ok = false;
			job.current.add(contact.name);
			refreshJobBar();
			try {
				ok = await analyzeContact(contact, books, options);
			} catch (e) {
				contact.cardState = "failed";
				contact.cardError = e.message;
			}
			if (ok && imageReady() && !job.stop && (force || !hasImageTags(contact))) {
				try {
					await ensureImageTags(contact, ctx, books, { force });
					contact.imageTagError = "";
				} catch (e) {
					contact.imageTagError = e.message;
				}
			}
			if ((ok && hasAnalyzedProfile(contact) || contact.manualAdd) && !state.contacts.some((c) => c.id === contact.id)) {
				const people = [
					...state.candidates || [],
					...state.contacts,
					contact
				];
				const key = resolvedPersonKey(contact, people);
				if (!state.contacts.some((c) => resolvedPersonKey(c, people) === key)) state.contacts.push(contact);
			}
			job.current.delete(contact.name);
			if (!ok) {
				job.failed++;
				job.failedIds.push(contact.id);
			}
			if (ok && contact.analysisReused) job.reused++;
			job.done++;
			await saveState(key);
			if (view.key === key && [
				"list",
				"profile",
				"pick"
			].includes(view.screen)) render();
			else refreshJobBar();
		});
		if (!job.stop) await generateTerms(state);
		if (view.analysis === job) view.analysis = null;
		if (view.key === key) {
			view.notice = job.stop ? `분석을 멈췄어요. ${job.done}명을 만들었고, 나머지는 사람 탭의 분석본 만들기로 이어서 할 수 있어요.` : `분석본 ${job.total - job.failed}명 준비 · 기존 분석 재사용 ${job.reused}명${job.failed ? ` · 실패 ${job.failed}명` : ""}`;
			view.noticeReanalyze = job.failedIds.length ? {
				notice: view.notice,
				ids: job.failedIds
			} : null;
			render();
		}
	}
	async function analyzeImageTags(state, contacts, force = false) {
		if (view.bioBusy || view.analysis) {
			view.notice = "진행 중인 작업이 끝난 뒤 다시 눌러 주세요.";
			render();
			return;
		}
		if (!contacts.length || !imageReady()) return;
		const key = view.key, ctx = view.ctx;
		const job = {
			total: contacts.length,
			done: 0,
			failed: 0,
			stop: false,
			label: "사진 태그 만드는 중"
		};
		view.analysis = job;
		view.imageAsk = false;
		render();
		const books = await loreBooks();
		await inPool(contacts, 2, async (contact) => {
			if (job.stop) return;
			try {
				await ensureImageTags(contact, ctx, books, { force });
				contact.imageTagError = "";
			} catch (e) {
				contact.imageTagError = e.message;
				job.failed++;
			}
			job.done++;
			await saveState(key);
			if (view.key === key && [
				"list",
				"profile",
				"set-photo"
			].includes(view.screen)) render();
			else refreshJobBar();
		});
		if (view.analysis === job) view.analysis = null;
		if (view.key === key) {
			const known = contacts.filter((c) => c.imageTags?.check?.state === "registered").length;
			view.notice = job.stop ? `사진 태그를 멈췄어요. ${job.done}명을 만들었어요.` : `사진 태그 ${job.total - job.failed}명 준비 · NovelAI 등록 캐릭터 ${known}명${job.failed ? ` · 실패 ${job.failed}명` : ""}`;
			render();
		}
	}
	const missingImageTags = (state) => state.contacts.filter((c) => hasAnalyzedProfile(c) && !hasImageTags(c));
	const unregisteredTags = (state) => state.contacts.filter((c) => c.imageTags?.schema === 1 && c.imageTags.check?.state !== "registered" && !c.imageTags.manual);
	async function recheckImageTags(state, contacts) {
		if (view.bioBusy || view.analysis || !imageReady() || !contacts.length) return;
		const key = view.key, ctx = view.ctx;
		const job = {
			total: contacts.length,
			done: 0,
			failed: 0,
			stop: false,
			label: "NovelAI 등록 다시 확인 중"
		};
		view.analysis = job;
		render();
		const books = await loreBooks();
		let found = 0;
		for (const contact of contacts) {
			if (job.stop) break;
			await checkImageTags(contact.imageTags, personNames(contact, books));
			if (contact.imageTags.check.state === "registered") found++;
			const lore = await memberLoreText(contact, books, contextBudget(state).analysis);
			await storeImageTags(ctx.char.chaId, contact, lore, contact.imageTags);
			job.done++;
			await saveState(key);
			refreshJobBar();
		}
		if (view.analysis === job) view.analysis = null;
		if (view.key === key) {
			view.notice = `${job.done}명을 다시 확인해서 ${found}명을 NovelAI 등록 캐릭터로 찾았어요.`;
			render();
		}
	}

//#endregion
//#region src/ui/screens/reanalyze.js
	function statusOf(c) {
		if (c.cardState === "no-lore") return {
			label: "로어 없음",
			can: false,
			needs: false
		};
		if (c.cardState === "failed") return {
			label: "분석 실패" + (c.cardError ? ` · ${String(c.cardError).slice(0, 60)}` : ""),
			can: true,
			needs: true,
			tone: "fail"
		};
		if (c.analysisStale) return {
			label: "로어 바뀜 · 다시 분석이 필요해요",
			can: true,
			needs: true,
			tone: "stale"
		};
		if (!c.card) return {
			label: "분석본 없음",
			can: true,
			needs: true
		};
		return {
			label: "분석됨",
			can: true,
			needs: false
		};
	}
	function openReanalyze(ids) {
		view.reanalyze = {
			ids: ids ? new Set(ids) : null,
			selected: null,
			q: ""
		};
		go("reanalyze", { notice: "" });
	}
	function reanalyzeScreen(state) {
		const r = view.reanalyze ||= {
			ids: null,
			selected: null,
			q: ""
		};
		const people = state.contacts.filter((c) => c.id !== "me");
		const ready = people.filter((c) => statusOf(c).can);
		if (!r.selected) r.selected = new Set(ready.filter((c) => r.ids ? r.ids.has(c.id) : statusOf(c).needs).map((c) => c.id));
		const selected = r.selected;
		for (const id of [...selected]) if (!ready.some((c) => c.id === id)) selected.delete(id);
		const q = normalize(r.q);
		const match = (c) => !q || normalize(c.name).includes(q) || (c.aliases || []).some((a) => normalize(a).includes(q));
		const busy = !!view.analysis || !!view.bioBusy;
		const label = () => `${selected.size}명 다시 분석`;
		const cost = (n) => `모델 약 ${n}회 · 입력 약 ${(n * ANALYSIS_TOKENS).toLocaleString()}토큰이 들어요.`;
		const runBtn = h("button", {
			class: "pill primary",
			"data-t": "reanalyze-run",
			disabled: !selected.size || busy,
			onclick: () => {
				if (selected.size >= CONFIRM_FROM && !runBtn.dataset.armed) {
					runBtn.dataset.armed = "1";
					runBtn.textContent = "한 번 더 누르면 시작";
					return;
				}
				const chosen = state.contacts.filter((c) => selected.has(c.id));
				view.reanalyze = null;
				go("list", {
					tab: "people",
					notice: ""
				});
				void analyzeInBackground(state, chosen, true);
			}
		}, label());
		const costBox = h("div", {
			class: "notice",
			"data-t": "reanalyze-cost",
			hidden: !selected.size
		}, cost(selected.size));
		const sync = () => {
			delete runBtn.dataset.armed;
			runBtn.textContent = label();
			runBtn.disabled = !selected.size || busy;
			costBox.textContent = cost(selected.size);
			costBox.hidden = !selected.size;
		};
		const row = (c) => {
			const s = statusOf(c);
			return h("label", {
				class: "row pick" + (s.can ? "" : " done"),
				"data-t": "reanalyze-row",
				"data-name": c.name
			}, avatar(c, 44), h("span", { class: "mid" }, h("span", { class: "nm" }, c.name), h("span", { class: "pv" }, h("span", {
				class: "tx" + (s.tone === "fail" ? " danger" : ""),
				"data-t": "reanalyze-status"
			}, s.label))), h("input", {
				type: "checkbox",
				checked: selected.has(c.id),
				disabled: !s.can,
				"aria-label": `${c.name} 선택`,
				"data-t": "reanalyze-item",
				"data-name": c.name,
				onchange: (e) => {
					if (e.target.checked) selected.add(c.id);
					else selected.delete(c.id);
					sync();
				}
			}), h("span", { class: "check" }));
		};
		const shown = people.filter(match);
		const needs = shown.filter((c) => statusOf(c).needs), done = shown.filter((c) => statusOf(c).can && !statusOf(c).needs), none = shown.filter((c) => !statusOf(c).can);
		const body = h("div", {
			class: "scroll",
			id: "scroll"
		});
		body.append(h("div", { class: "notice" }, "고른 사람을 로어로 다시 분석해요. 이미 분석된 사람도 고를 수 있어요."));
		if (busy) body.append(h("div", {
			class: "notice",
			"data-t": "reanalyze-busy"
		}, "진행 중인 작업이 끝난 뒤 시작할 수 있어요."));
		body.append(costBox);
		body.append(h("div", { class: "actions" }, h("button", {
			class: "pill",
			"data-t": "reanalyze-all",
			onclick: () => {
				for (const c of shown) if (statusOf(c).can) selected.add(c.id);
				render();
			}
		}, q ? "검색 결과 모두 선택" : "모두 선택"), h("button", {
			class: "pill",
			"data-t": "reanalyze-none",
			onclick: () => {
				selected.clear();
				render();
			}
		}, "선택 해제"), h("button", {
			class: "pill",
			"data-t": "reanalyze-needed",
			onclick: () => {
				selected.clear();
				for (const c of ready) if (statusOf(c).needs) selected.add(c.id);
				render();
			}
		}, "다시 해야 할 사람만")));
		if (needs.length) body.append(h("div", { class: "sect" }, "다시 해야 할 사람", h("small", {}, `${needs.length}명`)), h("div", { class: "rows" }, needs.map(row)));
		if (done.length) body.append(h("div", { class: "sect" }, "분석됨", h("small", {}, `${done.length}명`)), h("div", { class: "rows" }, done.map(row)));
		if (none.length) body.append(h("div", { class: "sect" }, "로어 없음", h("small", {}, `${none.length}명 · 분석할 로어가 없어요`)), h("div", { class: "rows" }, none.map(row)));
		if (!shown.length) body.append(h("div", { class: "hello" }, h("div", { class: "meta" }, people.length ? "찾는 사람이 없어요." : "아직 사람이 없어요.")));
		return [
			h("div", { class: "top line-b" }, backBtn(() => {
				view.reanalyze = null;
				go("list", { tab: "people" });
			}), h("h1", { class: "small" }, "다시 분석"), runBtn),
			h("label", {
				class: "search",
				style: "margin-top:8px"
			}, icon("search", 16), h("input", {
				id: "rq",
				value: r.q,
				placeholder: "이름으로 찾기",
				"aria-label": "사람 검색",
				"data-t": "reanalyze-search",
				oninput: (e) => {
					r.q = e.target.value;
					render(e.target);
				}
			})),
			body
		];
	}

//#endregion
//#region src/ui/screens/list.js
	function hasAnalyzedProfile(contact) {
		return !!(contact?.card && (contact.card["정체"] || contact.card["말투"]) && !contact.analysisStale && !["failed", "no-lore"].includes(contact.cardState));
	}
	function isVisibleContact(state, contact) {
		return hasAnalyzedProfile(contact) || !!contact?.manualAdd || !!(contact && state.rooms.some((r) => r.msgs?.length && r.members?.includes(contact.id)));
	}
	function listScreen(state) {
		const q = normalize(view.q);
		const showPhotos = imageCfg.enabled || photosOf(state).length > 0;
		if (view.tab === "photos" && !showPhotos) view.tab = "chats";
		const acct = accountOf(), self = acct === "me" ? view.me : personOf(state, acct);
		const openMe = () => acct === "me" ? go("me", {
			notice: "",
			meBioEdit: ""
		}) : (view.profileFrom = "list", openProfile(acct));
		const head = h("div", { class: "top" }, h("button", {
			class: "plain me-btn" + (acct === "me" ? "" : " acct"),
			"aria-label": "내 프로필",
			"data-t": "my-profile",
			onclick: openMe
		}, avatar(self, 36)), h("h1", {}, view.tab === "chats" ? "채팅" : view.tab === "photos" ? "사진" : "사람"), h("button", {
			class: "round",
			"aria-label": "설정",
			"data-t": "settings",
			onclick: () => go("settings")
		}, icon("gear")), h("button", {
			class: "round",
			"aria-label": "닫기",
			"data-t": "close",
			onclick: closeWindow
		}, icon("close")));
		const banner = acct === "me" ? null : h("div", {
			class: "acct-bar",
			"data-t": "account-banner"
		}, icon("swap", 18), h("span", { class: "mid" }, h("b", {}, self?.name || "?"), " 계정으로 보는 중"), h("button", {
			class: "pill",
			"data-t": "account-back",
			onclick: () => switchAccount("me")
		}, "내 계정으로"));
		const search = h("label", { class: "search" }, icon("search", 16), h("input", {
			id: "q",
			value: view.q,
			placeholder: view.tab === "chats" ? "채팅 검색" : "이름으로 찾기",
			"aria-label": "검색",
			"data-t": "search",
			oninput: (e) => {
				view.q = e.target.value;
				render(e.target);
			}
		}));
		const notice = view.notice ? h("div", {
			class: "notice",
			"data-t": "notice"
		}, view.notice, view.noticePick ? h("button", {
			class: "pill",
			"data-t": "notice-pick",
			onclick: openPicker
		}, "인물 고르기") : null, view.noticeReanalyze?.notice === view.notice ? h("button", {
			class: "pill",
			"data-t": "notice-reanalyze",
			onclick: () => {
				const { ids } = view.noticeReanalyze;
				view.noticeReanalyze = null;
				openReanalyze(ids);
			}
		}, "실패한 사람 다시 분석") : null) : null;
		const body = h("div", {
			class: "scroll",
			id: "scroll"
		}, notice);
		const match = (c) => !q || normalize(c.name).includes(q) || (c.aliases || []).some((a) => normalize(a).includes(q));
		if (view.tab === "chats") {
			const seen = state.contacts.filter((c) => c.id !== acct && isVisibleContact(state, c) && inStory(c));
			if (!q && seen.length) {
				body.append(h("div", { class: "active" }, seen.map((c) => h("button", {
					class: "act",
					"data-t": "active",
					"data-name": c.name,
					onclick: () => openRoom(dmRoomFor(state, c.id))
				}, avatar(c, 52, true), h("span", { class: "n" }, c.name)))));
			}
			const rooms = roomsOf(state, acct).filter((r) => r.msgs.length && (!q || normalize(roomTitle(state, r)).includes(q))).sort((a, b) => b.msgs[b.msgs.length - 1].t - a.msgs[a.msgs.length - 1].t);
			if (rooms.length) {
				body.append(h("div", { class: "rows" }, rooms.map((room) => {
					const last = room.msgs[room.msgs.length - 1];
					const prefix = (last.from === acct ? "나: " : room.type === "group" ? `${personOf(state, last.from)?.name || ""}: ` : "") + (last.photo ? "사진 " : "");
					return h("button", {
						class: "row" + (room.unread ? " un" : ""),
						"data-t": "room",
						"data-name": roomTitle(state, room),
						onclick: () => openRoom(room)
					}, roomAvatar(state, room, 56, true), h("span", { class: "mid" }, h("span", { class: "nm" }, roomTitle(state, room)), h("span", { class: "pv" }, h("span", { class: "tx" }, prefix + last.text), h("span", { class: "tm" }, `· ${ago(last.t)}`))), room.unread ? h("span", {
						class: "un-dot",
						"aria-label": `읽지 않은 메시지 ${room.unread}개`,
						"data-t": "unread"
					}) : null);
				})));
			} else {
				body.append(h("div", { class: "hello" }, h("div", { class: "meta" }, q ? "찾는 대화가 없어요." : "아직 대화가 없어요. 사람 탭에서 대화를 시작해 보세요.")));
			}
		} else {
			body.append(h("div", { class: "actions" }, h("button", {
				class: "pill",
				"data-t": "new-group",
				onclick: () => go("group")
			}, "단톡방 만들기"), h("button", {
				class: "pill",
				"data-t": "add-contact",
				onclick: () => openEdit("")
			}, "이름으로 분석"), h("button", {
				class: "pill primary",
				"data-t": "pick-people",
				onclick: openPicker
			}, "인물 고르기"), state.contacts.length ? h("button", {
				class: "pill",
				"data-t": "reanalyze-open",
				disabled: !!view.analysis,
				onclick: () => openReanalyze()
			}, "다시 분석") : null, (() => {
				const missing = state.contacts.filter((c) => !c.card && c.cardState !== "no-lore");
				return missing.length && !view.analysis ? h("button", {
					class: "pill",
					"data-t": "analyze-missing",
					onclick: async () => {
						const assets = await gatherAssets(view.ctx);
						for (const c of missing) if (!c.manualImage && !c.image) c.image = pickAsset(c, assets);
						await linkMissingAssets(state, missing, assets);
						analyzeInBackground(state, missing);
					}
				}, `분석본 만들기 (${missing.length})`) : null;
			})()));
			if (!q) body.append(h("div", { class: "rows" }, h("div", {
				class: "row",
				"data-t": "me-row"
			}, h("button", {
				class: "avbtn",
				"aria-label": "내 프로필",
				onclick: openMe
			}, avatar(self, 48)), h("button", {
				class: "mid rowmain",
				"data-t": "me-row-open",
				onclick: openMe
			}, h("span", { class: "nm" }, `${self?.name || "나"} (나)`), h("span", { class: "pv" }, h("span", { class: "tx" }, acct === "me" ? state.meBio || "한줄 소개를 남겨 보세요" : spell(displayBio(self)) || "")))), acct === "me" ? null : h("div", {
				class: "row",
				"data-t": "user-row"
			}, h("button", {
				class: "avbtn",
				"aria-label": `${view.me?.name || "나"} 대화`,
				onclick: () => openRoom(dmRoomFor(state, "me"))
			}, avatar(view.me, 48)), h("button", {
				class: "mid rowmain",
				"data-t": "user-row-open",
				onclick: () => openRoom(dmRoomFor(state, "me"))
			}, h("span", { class: "nm" }, `${view.me?.name || "나"} (사용자)`), h("span", { class: "pv" }, h("span", { class: "tx" }, state.meBio || ""))))));
			const people = state.contacts.filter((c) => c.id !== acct && isVisibleContact(state, c) && match(c));
			const appeared = people.filter(inStory), rest = people.filter((c) => !inStory(c));
			const row = (c) => h("div", { class: "row" }, h("button", {
				class: "avbtn",
				"aria-label": `${c.name} 프로필`,
				"data-t": "open-profile",
				"data-name": c.name,
				onclick: () => openProfile(c.id)
			}, avatar(c, 48, inStory(c))), h("button", {
				class: "mid rowmain",
				"data-t": "contact",
				"data-name": c.name,
				onclick: () => openRoom(dmRoomFor(state, c.id))
			}, h("span", { class: "nm" }, c.name), h("span", { class: "pv" }, h("span", { class: "tx" }, hasAnalyzedProfile(c) ? spell(displayBio(c)) || "대화를 시작해 보세요" : "분석이 필요해요"))));
			if (appeared.length) body.append(h("div", { class: "sect" }, "최근 대화에서 이름 확인", h("small", {}, `${appeared.length}명`)), h("div", { class: "rows" }, appeared.map(row)));
			if (rest.length) body.append(h("div", { class: "sect" }, "전체 인물", h("small", {}, `${rest.length}명`)), h("div", { class: "rows" }, rest.map(row)));
			if (!people.length) body.append(h("div", { class: "hello" }, h("div", { class: "meta" }, q ? "찾는 인물이 없어요." : "아직 인물이 없어요.")));
		}
		const tab = (id, label, ic) => h("button", {
			class: "tab",
			role: "tab",
			"aria-selected": String(view.tab === id),
			"data-t": `tab-${id}`,
			onclick: () => go("list", {
				tab: id,
				q: ""
			})
		}, icon(ic, 22), label);
		const tabs = h("div", {
			class: "tabs" + (showPhotos ? " three" : ""),
			role: "tablist"
		}, tab("chats", "채팅", "chat"), tab("people", "사람", "people"), showPhotos ? tab("photos", "사진", "photo") : null);
		if (view.tab === "photos") return [
			head,
			banner,
			galleryBody(state),
			tabs
		].filter(Boolean);
		return [
			head,
			banner,
			search,
			body,
			tabs
		].filter(Boolean);
	}
	const roomTitle = (state, room, acct = accountOf()) => room.type === "group" ? room.name : roomPartner(state, room, acct)?.name || room.name;

//#endregion
//#region src/ui/screens/edit.js
	async function openEdit(contactId) {
		if (!view.assets) await gatherAssets(view.ctx);
		go("edit", { contactId });
	}
	function readProfileFile(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result);
			reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다"));
			reader.readAsDataURL(file);
		});
	}
	const ASSET_PAGE = 15;
	function assetGallery(draft, state, assets, onSelect, chatPhotos = null, photoGroups = []) {
		const groups = new Map();
		const add = (label, photos) => {
			if (photos.length && !groups.has(label)) groups.set(label, photos);
		};
		if (chatPhotos) add("이 채팅의 사진", chatPhotos);
		for (const [label, photos] of photoGroups) add(label, photos);
		if (assets) {
			add("이 인물 추천", rankedAssets(draft, assets));
			for (const c of dedupeCandidates([...state.candidates || [], ...state.contacts])) {
				add(c.lore || c.name, rankedAssets(c, assets));
			}
			const owners = new Map();
			for (const a of assets) {
				const label = assetPersonName(a.name) || "기타";
				if (!owners.has(label)) owners.set(label, []);
				owners.get(label).push(a);
			}
			for (const [label, photos] of owners) add(label, photos);
			groups.set("전체 에셋", assets);
		}
		let chosen = groups.has("이 채팅의 사진") ? "이 채팅의 사진" : groups.has("이 인물 추천") ? "이 인물 추천" : "전체 에셋", page = 0;
		if (!groups.has(chosen)) chosen = groups.keys().next().value || "";
		const tabs = h("div", {
			class: "gallery-tabs",
			"data-t": "asset-groups"
		});
		const grid = h("div", {
			class: "photos asset-grid",
			"data-t": "asset-grid"
		});
		const info = h("div", {
			class: "sub",
			"data-t": "asset-count"
		});
		const pager = h("div", {
			class: "pager",
			"data-t": "asset-pager"
		});
		const query = h("input", {
			type: "search",
			placeholder: "로어북·인물·이미지 이름 검색",
			"aria-label": "갤러리 검색",
			"data-t": "asset-search",
			oninput: () => {
				page = 0;
				draw();
			}
		});
		function draw() {
			const q = normalize(query.value || "");
			tabs.replaceChildren(...[...groups].filter(([label, photos]) => !q || normalize(label).includes(q) || photos.some((a) => normalize(a.name).includes(q))).map(([label]) => h("button", {
				class: "pill" + (chosen === label ? " primary" : ""),
				"data-t": "asset-group",
				"data-name": label,
				"aria-pressed": String(chosen === label),
				onclick: () => {
					chosen = label;
					page = 0;
					draw();
				}
			}, label)));
			const photos = (groups.get(chosen) || []).filter((a) => !q || normalize(chosen).includes(q) || normalize(a.name).includes(q));
			info.textContent = `${chosen || "에셋"} · ${photos.length}개`;
			const pages = Math.max(1, Math.ceil(photos.length / ASSET_PAGE));
			page = Math.min(page, pages - 1);
			grid.replaceChildren(...photos.slice(page * ASSET_PAGE, (page + 1) * ASSET_PAGE).map((a) => {
				const button = h("button", {
					type: "button",
					title: a.name,
					"aria-label": `${a.name} 선택`,
					"aria-pressed": String(draft.image === a.path),
					"data-t": "asset-photo",
					"data-name": a.name,
					onclick: () => {
						const pending = onSelect(a);
						draw();
						if (pending?.then) pending.then(() => {
							if (grid.isConnected) draw();
						});
					}
				}, draft.image === a.path ? h("span", { class: "now" }, "선택됨") : null);
				lazily(button, () => (a.photoId ? photoThumb(a.photoId) : imageUrl(a.path)).then((url) => {
					if (url) button.prepend(h("img", {
						src: url,
						alt: a.name,
						loading: "lazy"
					}));
				}));
				return button;
			}));
			const turn = (to) => {
				page = to;
				draw();
				grid.scrollIntoView?.({ block: "nearest" });
			};
			pager.replaceChildren(h("button", {
				class: "pill",
				"data-t": "asset-prev",
				disabled: page === 0,
				onclick: () => turn(page - 1)
			}, "‹ 이전"), h("span", {
				class: "sub",
				"data-t": "asset-page"
			}, `${page + 1} / ${pages}`), h("button", {
				class: "pill",
				"data-t": "asset-next",
				disabled: page >= pages - 1,
				onclick: () => turn(page + 1)
			}, "다음 ›"));
			pager.style.display = pages > 1 ? "" : "none";
		}
		draw();
		return h("div", {
			class: "asset-gallery",
			"data-t": "asset-gallery"
		}, query, tabs, info, grid, pager);
	}
	function profilePhotoGroups(state, contact) {
		const item = (id, name, t, w, hgt) => ({
			name: `${name} · ${clock(t)}`,
			path: "photo:" + id,
			photoId: id,
			w,
			h: hgt
		});
		const groups = [], profiles = [];
		const shots = (contact?.profileShots || []).filter((s) => s.id).slice().reverse();
		if (shots.length) profiles.push(["생성 프로필", shots.map((s) => item(s.id, contact.name || "프로필", s.t, s.w, s.h))]);
		const rooms = (state.rooms || []).map((room) => ({
			room,
			msgs: room.msgs.filter((m) => m.photo?.state === "done" && m.photo.id).reverse()
		})).filter((r) => r.msgs.length).sort((a, b) => b.msgs[0].t - a.msgs[0].t);
		const used = new Set();
		for (const { room, msgs } of rooms) {
			let label = "채팅 · " + roomTitle(state, room);
			for (let n = 2; used.has(label); n++) label = `채팅 · ${roomTitle(state, room)} (${n})`;
			used.add(label);
			groups.push([label, msgs.map((m) => item(m.photo.id, personOf(state, m.from)?.name || "사진", m.t, m.photo.w, m.photo.h))]);
		}
		return [profiles, groups];
	}
	function editScreen(state) {
		const editKey = view.key;
		const existing = state.contacts.find((c) => c.id === view.contactId);
		const draft = existing ? { ...existing } : {
			id: newId(),
			name: "",
			bio: "",
			role: "",
			aliases: [],
			asset: "",
			lore: "",
			image: "",
			manualImage: false
		};
		const text = (label, value, testId, placeholder) => h("label", { class: "field" }, h("span", { class: "label" }, label), h("input", {
			type: "text",
			value,
			placeholder,
			"data-t": testId
		}));
		const name = text("이름", draft.name, "contact-name", "이름");
		const bio = text("프로필 상태메시지", draft.bio || "", "contact-bio", "본인이 프로필에 남길 짧은 한마디");
		const role = text("설명", draft.role || "", "contact-role", "소속이나 관계");
		const address = text("이 인물이 나를 부르는 호칭", draft.userAddress || "", "contact-address", "비우면 현재 페르소나 이름");
		const note = h("label", { class: "field" }, h("span", { class: "label" }, "내 메모 (분석본보다 우선)"), h("textarea", {
			rows: 2,
			placeholder: "예: 이 챗에서는 학생회장을 그만둔 상태",
			"aria-label": "내 메모",
			"data-t": "contact-note"
		}, draft.cardNote || ""));
		const preview = h("div", { class: "center" }, avatar(draft, 96));
		const showPreview = () => {
			preview.replaceChildren(avatar(draft, 96));
			adjust.disabled = !draft.image;
		};
		const assets = view.assets || assetList(view.ctx.char);
		const selectImage = async (source) => {
			const crop = await editProfileCrop(source, draft.imageCrop);
			if (!crop || view.key !== editKey || !preview.isConnected) return;
			Object.assign(draft, {
				image: source,
				imageCrop: crop,
				manualImage: true
			});
			showPreview();
		};
		const adjust = h("button", {
			class: "pill",
			"data-t": "contact-photo-adjust",
			disabled: !draft.image,
			onclick: () => selectImage(draft.image)
		}, "표시 영역 조정");
		const [shotGroups, roomGroups] = profilePhotoGroups(state, existing);
		const count = (groups) => groups.reduce((n, [, photos]) => n + photos.length, 0);
		const openPhotos = (title, testId, galleryAssets, photoGroups) => {
			const sheet = h("div", {
				class: "picker-sheet",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": title,
				"data-t": "asset-picker",
				"data-source": testId
			}, h("div", { class: "top line-b" }, h("button", {
				class: "plain",
				"aria-label": "뒤로",
				"data-t": "asset-picker-close",
				onclick: () => sheet.remove()
			}, icon("back", 24)), h("h1", { class: "small" }, title)), h("div", { class: "picker-body" }, assetGallery(draft, state, galleryAssets, async (a) => {
				const source = a.photoId ? await photoFull(a.photoId) : a.path;
				if (!source) return;
				await selectImage(source);
				if (draft.image === source) sheet.remove();
			}, null, photoGroups)));
			document.getElementById("win").append(sheet);
		};
		const source = (testId, title, n, hint, empty, open) => h("button", {
			class: "set",
			"data-t": testId,
			disabled: !n,
			onclick: open
		}, h("span", { class: "mid" }, `${title} (${n})`, h("small", {}, n ? hint : empty)), icon("next", 18));
		const gallery = h("div", {
			class: "photo-sources",
			"data-t": "photo-sources"
		}, source("open-profile-shots", "생성 프로필에서 고르기", count(shotGroups), "이 인물을 그린 프로필 사진이에요.", "아직 이 인물을 그린 프로필이 없어요.", () => openPhotos("생성 프로필", "open-profile-shots", null, shotGroups)), source("open-chat-photos", "채팅 사진에서 고르기", count(roomGroups), "이 채팅에서 그린 사진을 채팅방별로 보여 줘요.", "이 채팅에서 그린 사진이 아직 없어요.", () => openPhotos("채팅 사진", "open-chat-photos", null, roomGroups)), source("open-asset-picker", "에셋에서 고르기", assets.length, "이 인물 추천·인물별·전체 에셋에서 골라요.", "이 봇에 에셋이 없어요.", () => openPhotos("에셋", "open-asset-picker", assets, [])));
		const fileNotice = h("div", {
			class: "sub",
			role: "alert"
		});
		const file = h("input", {
			type: "file",
			accept: "image/*",
			"aria-label": "이미지 파일",
			onchange: async () => {
				if (!file.files[0]) return;
				try {
					const source = await readProfileFile(file.files[0]);
					if (view.key === editKey && preview.isConnected) await selectImage(source);
				} catch {
					fileNotice.textContent = "이미지 파일을 읽지 못했어요.";
				} finally {
					file.value = "";
				}
			}
		});
		const leave = () => existing ? go("profile") : go("list", { tab: "people" });
		const save = async () => {
			if (!existing && (view.analysis || view.bioBusy)) return;
			const value = name.querySelector("input").value.trim();
			if (!value) return;
			draft.name = value;
			const newBio = bio.querySelector("input").value.trim();
			if (newBio !== (draft.bio || "")) draft.manualBio = true;
			draft.bio = newBio;
			draft.cardNote = note.querySelector("textarea").value.trim();
			draft.role = role.querySelector("input").value.trim();
			draft.userAddress = address.querySelector("input").value.trim().slice(0, 40);
			const old = existing ? { ...existing } : null;
			if (existing) {
				Object.assign(existing, draft);
			} else {
				state.removedNames = (state.removedNames || []).filter((n) => n !== normalize(value));
				if (!draft.image) draft.image = pickAsset(draft, assets);
				draft.manualAdd = true;
			}
			try {
				await saveState(editKey);
			} catch {
				if (existing) {
					for (const field of Object.keys(existing)) if (!(field in old)) delete existing[field];
					Object.assign(existing, old);
				}
				fileNotice.textContent = "프로필을 저장하지 못했어요. 다시 시도해 주세요.";
				return;
			}
			leave();
			if (!existing) analyzeInBackground(state, [draft]);
		};
		return [h("div", { class: "top line-b" }, backBtn(leave), h("h1", { class: "small" }, existing ? "프로필 수정" : "이름으로 분석"), closeBtn()), h("div", {
			class: "scroll",
			id: "scroll"
		}, preview, h("div", { class: "actions" }, adjust, h("button", {
			class: "pill primary",
			"data-t": "contact-save-top",
			disabled: !existing && (!!view.analysis || !!view.bioBusy),
			onclick: save
		}, existing ? "저장" : "분석 후 추가")), name, bio, role, address, note, h("div", { class: "field" }, h("span", { class: "label" }, "프로필 사진"), gallery), h("div", { class: "field" }, file, fileNotice), h("div", { class: "actions" }, h("button", {
			class: "pill primary",
			"data-t": "contact-save",
			disabled: !existing && (!!view.analysis || !!view.bioBusy),
			onclick: save
		}, existing ? "저장" : "분석 후 추가")))];
	}

//#endregion
//#region src/ui/screens/profile.js
	async function openProfile(contactId) {
		if (!view.assets) await gatherAssets(view.ctx);
		const state = states.get(view.key), contact = state.contacts.find((c) => c.id === contactId);
		view.cardStale = false;
		if (contact?.card && contact.loreHash) view.cardStale = loreHash(await memberCardText(contact, await loreBooks(), contextBudget(state).analysis)) !== contact.loreHash;
		go("profile", {
			contactId,
			profileFrom: view.screen === "profile" ? view.profileFrom : view.screen === "edit" ? view.profileFrom : view.screen
		});
	}
	function bioAction(state, contact) {
		const token = view.key + "|" + contact.id;
		const btn = h("button", {
			class: "pill",
			"data-t": "bio-generate",
			disabled: !!view.bioBusy || !!view.analysis,
			onclick: async () => {
				if (view.bioBusy || view.analysis) return;
				if (contact.manualBio && !btn.dataset.armed) {
					btn.dataset.armed = "1";
					btn.textContent = "한 번 더 누르면 직접 쓴 소개를 새로 씁니다";
					return;
				}
				const key = view.key, ctx = view.ctx, snapshot = { ...contact };
				view.bioBusy = token;
				contact.bioError = "";
				render();
				try {
					const lore = await memberCardText(contact, await loreBooks(), contextBudget(state).analysis);
					const card = lore && (contact.analysisLore ? contact.analysisLore === lore : contact.loreHash === loreHash(lore)) ? verifiedSharedCard(contact.card, lore) : null;
					if (!card) throw new Error("현재 로어로 확인된 분석본이 필요해요. 먼저 인물을 분석해 주세요.");
					const draft = {
						...contact,
						manualBio: false
					};
					const next = await ensureCardBio(draft, card, lore, {
						...analysisOptions(ctx),
						forceBio: true
					});
					if (draft.bioError || next === card) throw new Error(draft.bioError || "상태메시지를 만들지 못했어요.");
					if (!state.contacts.includes(contact)) return;
					if (contact.bio !== snapshot.bio || contact.manualBio !== snapshot.manualBio || contact.name !== snapshot.name || contact.lore !== snapshot.lore || contact.card !== snapshot.card) throw new Error("작성 중 프로필이나 분석본이 바뀌어 새 문구를 저장하지 않았어요.");
					contact.manualBio = false;
					applySharedAnalysis(contact, next, lore);
					try {
						await saveState(key);
					} catch (e) {
						Object.assign(contact, snapshot);
						throw e;
					}
					await storeSharedAnalysis(sharedAnalysisKey(ctx.char.chaId, contact, lore), ctx.char.chaId, contact, lore, next);
				} catch (e) {
					contact.bioError = e.message;
				} finally {
					if (view.bioBusy === token) view.bioBusy = "";
					render();
				}
			}
		}, view.bioBusy === token ? "상태메시지 쓰는 중…" : "상태메시지 다시 쓰기");
		return btn;
	}
	function profileScreen(state) {
		const c = state.contacts.find((x) => x.id === view.contactId);
		if (!c) return listScreen(state);
		const room = state.rooms.find((r) => r.type === "dm" && !r.as && r.members[0] === c.id);
		const groups = state.rooms.filter((r) => r.type === "group" && !r.as && r.members.includes(c.id));
		const present = inStory(c);
		const head = h("div", { class: "top line-b" }, backBtn(() => go(view.profileFrom === "room" ? "room" : "list")), h("h1", { class: "small" }, c.name), closeBtn());
		const cover = h("div", { class: "cover" });
		if (c.image) lazily(cover, () => profileImageUrl(c).then((url) => {
			if (url) cover.append(h("img", {
				src: url,
				alt: ""
			}));
		}));
		const photos = rankedAssets(c, view.assets || []).slice(0, 9);
		const photoCard = photos.length ? h("section", { class: "card" }, h("h3", {}, "사진", h("small", {}, "눌러서 프로필로 지정")), h("div", { class: "photos" }, photos.map((a) => {
			const btn = h("button", {
				"aria-label": `${a.name} 프로필로 지정`,
				"data-t": "photo",
				onclick: async () => {
					const key = view.key, crop = await editProfileCrop(a.path, c.imageCrop);
					if (!crop || view.key !== key) return;
					const old = {
						image: c.image,
						imageCrop: c.imageCrop,
						manualImage: c.manualImage
					};
					Object.assign(c, {
						image: a.path,
						imageCrop: crop,
						manualImage: true
					});
					try {
						await saveState(key);
					} catch {
						Object.assign(c, old);
						view.notice = "프로필 사진을 저장하지 못했어요.";
					}
					render();
				}
			}, c.image === a.path ? h("span", { class: "now" }, "프로필") : null);
			lazily(btn, () => imageUrl(a.path).then((url) => {
				if (url) btn.prepend(h("img", {
					src: url,
					alt: ""
				}));
				else btn.remove();
			}));
			return btn;
		}))) : null;
		const inject = room ? room.inject !== false : true;
		return [head, h("div", {
			class: "scroll",
			id: "scroll"
		}, cover, h("div", { class: "prof" }, h("span", { class: "ring" }, avatar(c, 104, present)), h("h2", {}, c.name), h("div", { class: "st" }, present ? "최근 대화에 이름 확인" : "최근 대화에 이름 미확인"), h("div", {
			class: "bio",
			"data-t": "profile-bio"
		}, spell(displayBio(c)) || "아직 상태메시지가 없어요."), bioAction(state, c)), c.bioError ? h("div", {
			class: "notice",
			role: "alert",
			"data-t": "bio-error"
		}, c.bioError) : null, c.card && c.card.bioSchema !== 1 && !c.manualBio ? h("div", {
			class: "notice",
			"data-t": "bio-legacy"
		}, "이전 방식의 소개입니다. 상태메시지만 다시 쓸 수 있어요. 인물 분석은 다시 하지 않습니다.") : null, h("div", { class: "acts" }, c.id === accountOf() ? switchButton("profile") : h("button", {
			class: "act2",
			"data-t": "profile-message",
			onclick: () => openRoom(dmRoomFor(state, c.id))
		}, h("span", { class: "round primary" }, icon("chat")), "메시지"), h("button", {
			class: "act2",
			"data-t": "profile-edit",
			onclick: () => openEdit(c.id)
		}, h("span", { class: "round" }, icon("pen")), "소개 수정"), h("button", {
			class: "act2",
			"data-t": "profile-photo",
			onclick: () => openEdit(c.id)
		}, h("span", { class: "round" }, icon("camera")), "사진 변경")), h("section", { class: "card" }, h("h3", {}, "소개"), h("div", { class: "fact" }, icon("book"), h("span", {}, present ? "최근 대화에서 이름을 확인했어요." : "최근 대화에서 이름을 확인하지 못했어요.")), c.lore ? h("div", { class: "fact" }, icon("spark"), h("span", {}, `로어북 항목 "${c.lore}"`)) : null), analysisSection(state, c), memorySection(state, c), imageTagSection(state, c), photoCard, groups.length ? h("section", { class: "card" }, h("h3", {}, "함께 있는 단톡방"), groups.map((r) => h("button", {
			class: "row flat",
			onclick: () => openRoom(r)
		}, roomAvatar(state, r, 40), h("span", { class: "mid" }, h("span", { class: "nm" }, r.name), h("span", { class: "pv" }, h("span", { class: "tx" }, `${r.members.length + 1}명`)))))) : null, h("section", { class: "card" }, h("h3", {}, "채팅 설정"), toggleRow("이 대화를 본편에 반영", "이 사람과 나눈 대화를 본편 요청에 함께 보냅니다.", inject, async (on) => {
			dmRoom(state, c).inject = on;
			await saveState(view.key);
		}, "room-inject"), room?.msgs.length ? h("button", {
			class: "set",
			"data-t": "room-export",
			onclick: () => downloadJson(`interlude-${c.name}.json`, makeBackup(view.ctx, state, room))
		}, h("span", { class: "mid" }, "대화 내보내기", h("small", {}, `메시지 ${room.msgs.length}개`))) : null, confirmButton("목록에서 삭제", () => removeContact(state, c), "contact-delete")))];
	}
	function analysisSection(state, c) {
		const card = c.card;
		const again = (label) => h("button", {
			class: "pill",
			"data-t": "reanalyze",
			disabled: !!view.analysis || !!view.bioBusy,
			onclick: async () => {
				await analyzeInBackground(state, [c], c.cardSchema === 2);
				view.cardStale = false;
				render();
			}
		}, label);
		if (!card) {
			const text = c.cardState === "no-lore" ? "이 인물의 로어북 항목을 찾지 못해서 분석본이 없어요." : c.cardState === "failed" ? `분석에 실패했어요. ${c.cardError || ""}` : "아직 분석본이 없어요. 답장에는 로어 원문을 씁니다.";
			return h("section", {
				class: "card",
				"data-t": "analysis-card"
			}, h("h3", {}, "분석본"), h("div", { class: "sub" }, text), h("div", { class: "actions flush" }, again("분석하기")));
		}
		const fact = (label, value) => {
			const text = spell(Array.isArray(value) ? value.filter(Boolean).join(", ") : value);
			return text ? h("div", { class: "kv" }, h("span", { class: "k" }, label), h("span", {}, text)) : null;
		};
		return h("section", {
			class: "card",
			"data-t": "analysis-card"
		}, h("div", { class: "actions flush" }, again("다시 분석하기")), c.contextUsage?.length ? h("pre", {
			class: "debug-raw",
			"data-t": "analysis-context-usage"
		}, contextUsageText(c.contextUsage)) : null, h("details", { "data-t": "analysis-details" }, h("summary", {
			class: "analysis-summary",
			"data-t": "analysis-summary"
		}, "상세"), c.cardSchema === 2 ? h("div", { class: "sub" }, "같은 봇의 다른 챗에서도 이 분석을 재사용합니다. 호칭과 내 메모는 이 챗에만 적용돼요.") : null, c.cardSchema !== 2 ? h("div", {
			class: "notice flush",
			"data-t": "card-legacy"
		}, "이전 분석본입니다. 답장에는 로어 원문을 사용해요. 다시 분석하면 대상별 호칭과 원문 근거를 확인합니다.") : null, view.cardStale ? h("div", {
			class: "notice flush",
			"data-t": "card-stale"
		}, "로어북이 바뀌었어요. 다시 분석하면 반영돼요.") : null, fact("정체", card["정체"]), fact("소속", card["소속"]), fact("직책", card["직책"]), fact("1인칭", card["1인칭"]), fact("말투", card["말투"]), fact("설정상 관계", card["관계"]), !card["정체"] && c.role ? fact("설명", c.role) : null, c.cardSchema === 2 ? fact("대상별 호칭", (card["호칭관계"] || []).map((r) => `${r["대상"]} → ${r["호칭"]}`)) : fact("이전 호칭 (미적용)", card["상대호칭"]), c.cardSchema === 2 ? h("details", {}, h("summary", {}, "원문 근거 보기"), Object.entries(card["근거"] || {}).map(([label, quote]) => fact(label, quote))) : null, c.cardNote ? fact("내 메모", c.cardNote) : null));
	}
	function trainedLabel(count) {
		return count >= 5e3 ? "많이 학습됨" : count >= 1e3 ? "학습됨" : "적게 학습됨 · 덜 닮을 수 있어요";
	}
	const memoryDeletes = new Set();
	async function clearContactMemory(key, contactId, confirmedIds) {
		const state = states.get(key), contact = state?.contacts.find((c) => c.id === contactId);
		if (!state?.enabled || !state.newMemory || !contact || !Array.isArray(confirmedIds)) throw new Error("메모리를 지울 인물이나 화면 상태가 바뀌었어요.");
		const lock = JSON.stringify([key, contactId]);
		if (memoryDeletes.has(lock)) throw new Error("메모리를 삭제하는 중이에요.");
		if (state.rooms.some((r) => r.members.includes(contactId) && memoryJobs.has(key + "|" + r.id))) throw new Error("메모리 정리가 끝난 뒤 삭제해 주세요.");
		const ids = new Set(confirmedIds), previous = memoryOf(contact);
		const removed = previous.filter((x) => ids.has(x.id));
		if (!removed.length) return 0;
		memoryDeletes.add(lock);
		contact.memory = previous.filter((x) => !ids.has(x.id));
		try {
			await saveState(key);
			return removed.length;
		} catch (error) {
			const current = memoryOf(contact), currentIds = new Set(current.map((x) => x.id));
			contact.memory = [...removed.filter((x) => !currentIds.has(x.id)), ...current];
			throw error;
		} finally {
			memoryDeletes.delete(lock);
		}
	}
	function memorySection(state, c) {
		if (!state.newMemory) return null;
		const key = view.key;
		const save = async () => {
			await saveState(key);
			if (view.key === key) render();
		};
		const all = memoryOf(c);
		const deleting = memoryDeletes.has(JSON.stringify([key, c.id]));
		const tidying = state.rooms.some((r) => r.members.includes(c.id) && memoryJobs.has(key + "|" + r.id));
		const newest = (list) => list.slice().sort((a, b) => b.t - a.t);
		const facts = newest(all.filter((x) => x.type === "fact"));
		const pinned = newest(all.filter((x) => x.type !== "fact" && x.pinned && !x.archived));
		const recent = newest(all.filter((x) => x.type !== "fact" && !x.pinned && !x.archived));
		const archived = newest(all.filter((x) => x.type !== "fact" && x.archived));
		const date = (t) => {
			const d = new Date(t);
			return `${d.getMonth() + 1}/${d.getDate()}`;
		};
		const tidy = (text) => text.replace(/\s+/g, " ").trim().slice(0, MEMORY_TEXT);
		const pill = (label, testId, onclick) => h("button", {
			class: "pill",
			"data-t": testId,
			disabled: deleting,
			onclick
		}, label);
		const row = (x) => {
			if (view.memEdit === x.id) {
				const input = h("textarea", {
					rows: 2,
					"aria-label": "메모리 고치기",
					"data-t": "memory-edit-text"
				}, x.text);
				return h("div", { class: "mem" }, h("label", { class: "field flat" }, input), h("div", { class: "actions flush" }, h("button", {
					class: "pill primary",
					"data-t": "memory-edit-save",
					disabled: deleting,
					onclick: async () => {
						const text = tidy(input.value);
						if (!text) return;
						Object.assign(x, {
							text,
							by: "user",
							t: Date.now()
						});
						view.memEdit = "";
						await save();
					}
				}, "저장"), pill("취소", "memory-edit-cancel", () => {
					view.memEdit = "";
					render();
				})));
			}
			const del = pill("삭제", "memory-delete", async () => {
				if (!del.dataset.armed) {
					del.dataset.armed = "1";
					del.textContent = "한 번 더 누르면 삭제";
					setTimeout(() => {
						delete del.dataset.armed;
						del.textContent = "삭제";
					}, 4e3);
					return;
				}
				c.memory = memoryOf(c).filter((y) => y !== x);
				await save();
			});
			return h("div", {
				class: "mem",
				"data-t": "memory-item",
				"data-id": x.id
			}, h("div", {}, x.text), h("small", { class: "sub" }, [
				x.archived ? x.merged ? "보관 · 합쳐짐" : "보관" : MEMORY_TYPES[x.type],
				x.room || "",
				date(x.t),
				x.by === "user" ? "직접 씀" : ""
			].filter(Boolean).join(" · ")), h("div", { class: "actions flush" }, x.type === "fact" ? null : pill(x.pinned ? "고정 해제" : "고정", "memory-pin", async () => {
				x.pinned = !x.pinned;
				if (x.pinned) {
					delete x.archived;
					delete x.merged;
				}
				await save();
			}), x.archived ? pill("다시 꺼내기", "memory-restore", async () => {
				delete x.archived;
				delete x.merged;
				x.t = Date.now();
				settleMemory(c);
				await save();
			}) : x.type === "fact" || x.pinned ? null : pill("보관", "memory-archive", async () => {
				x.archived = true;
				await save();
			}), pill("고치기", "memory-edit", () => {
				view.memEdit = x.id;
				render();
			}), del));
		};
		const group = (title, list, empty) => [h("h4", { class: "mem-h" }, `${title} ${list.length}`), list.length ? list.map(row) : h("div", { class: "sub" }, empty)];
		const typeSelect = h("select", {
			"aria-label": "메모리 종류",
			"data-t": "memory-type"
		}, Object.entries(MEMORY_TYPES).map(([id, label]) => h("option", { value: id }, id === "fact" ? "설정 메모리" : `대화 메모리 · ${label}`)));
		const input = h("textarea", {
			rows: 2,
			placeholder: "예: 매운 음식을 못 먹는다는 걸 안다",
			"aria-label": "새 메모리",
			"data-t": "memory-new"
		});
		const archiveOpen = view.memArchive === c.id;
		const bulk = confirmButton(`이 인물의 메모리 전체 삭제 (${all.length}개)`, async () => {
			view.memDeleteError = null;
			try {
				const work = clearContactMemory(key, c.id, all.map((x) => x.id));
				render();
				await work;
				if (view.key === key) {
					view.memEdit = "";
					view.memArchive = "";
				}
			} catch (e) {
				view.memDeleteError = {
					key,
					contactId: c.id,
					text: e.message
				};
			} finally {
				if (view.key === key) render();
			}
		}, "memory-clear-all");
		bulk.disabled = !all.length || deleting || tidying;
		return h("section", {
			class: "card",
			"data-t": "memory"
		}, h("h3", {}, "메모리", h("small", {}, `${all.length}개`)), h("div", { class: "sub" }, "설정 메모리는 항상 가장 먼저 지켜요. 대화 메모리는 이 챗의 메신저에서 생긴 일이에요. 고정하거나 직접 쓴 메모리는 자동 정리가 고치지 않아요."), h("details", { "data-t": "memory-bulk" }, h("summary", { class: "analysis-summary" }, "메모리 일괄 삭제"), h("div", { class: "sub top-gap" }, `${c.name}의 설정·고정·최근·보관 메모리를 모두 삭제합니다. 다른 인물의 메모리와 채팅 기록, 본편의 요약은 유지됩니다.`), deleting ? h("div", {
			class: "sub",
			role: "status"
		}, "메모리를 삭제하는 중이에요…") : null, tidying ? h("div", { class: "sub" }, "메모리 정리가 끝나면 삭제할 수 있어요.") : null, bulk), view.memDeleteError?.key === key && view.memDeleteError.contactId === c.id ? h("div", {
			class: "notice flush",
			role: "alert",
			"data-t": "memory-clear-error"
		}, "메모리를 삭제하지 못했어요. " + view.memDeleteError.text) : null, ...group("설정 메모리", facts, "아직 없어요."), ...group("고정", pinned, "고정한 메모리가 없어요."), ...group("최근", recent, "아직 없어요."), archived.length ? pill(archiveOpen ? "보관 접기" : `보관 ${archived.length}개 보기`, "memory-archive-toggle", () => {
			view.memArchive = archiveOpen ? "" : c.id;
			render();
		}) : null, archiveOpen ? archived.map(row) : null, archived.length >= MEMORY_ARCHIVE ? h("div", {
			class: "notice flush",
			"data-t": "memory-archive-full"
		}, `보관이 ${MEMORY_ARCHIVE}개를 넘었어요. 필요 없는 메모리를 정리해 주세요.`) : null, h("label", { class: "field flat" }, h("span", { class: "label" }, "메모리 추가"), typeSelect), h("label", { class: "field flat" }, input), h("div", { class: "actions flush" }, h("button", {
			class: "pill primary",
			"data-t": "memory-add",
			disabled: deleting,
			onclick: async () => {
				const text = tidy(input.value);
				if (!text) return;
				c.memory = [...memoryOf(c), newMemory(typeSelect.value, text, "user")];
				settleMemory(c);
				await save();
			}
		}, "추가")));
	}
	function imageTagSection(state, c) {
		const sent = photosOf(state, c.id);
		if (!imageCfg.enabled && !c.imageTags && !sent.length) return null;
		const t = c.imageTags;
		const st = t?.check?.state;
		const status = !t ? "아직 사진 태그가 없어요. 처음 사진을 보낼 때 만들거나 아래에서 바로 만들 수 있어요." : st === "registered" ? `✓ NovelAI ${modelLabel(t.check.model)}에 등록된 캐릭터예요 · ${trainedLabel(t.check.count)}` : st === "error" ? `NovelAI에서 확인하지 못했어요. ${t.check.error || ""}` : `✗ NovelAI ${modelLabel(t.check?.model || imageCfg.model)}가 모르는 인물이에요. 외형 태그로 그립니다.`;
		const key = view.key, ctx = view.ctx;
		const charInput = h("input", {
			type: "text",
			value: t?.check?.state === "registered" ? t.character : (t?.candidates || [])[0] || "",
			placeholder: "예: saber (fate)",
			"aria-label": "캐릭터 태그",
			"data-t": "tag-character"
		});
		const copyInput = h("input", {
			type: "text",
			value: t?.copyright || t?.copyrightGuess || "",
			placeholder: "예: fate (series)",
			"aria-label": "작품 태그",
			"data-t": "tag-copyright"
		});
		const parts = tagParts(t);
		const looksInput = h("textarea", {
			rows: 3,
			"aria-label": "외형 태그",
			"data-t": "tag-looks"
		}, parts.looks);
		const outfitInput = h("textarea", {
			rows: 2,
			"aria-label": "기본 의상 태그",
			"data-t": "tag-outfit"
		}, parts.outfit);
		const gender = h("select", {
			"aria-label": "성별",
			"data-t": "tag-gender"
		}, [
			["girl", "여성"],
			["boy", "남성"],
			["other", "기타"]
		].map(([v, label]) => h("option", {
			value: v,
			selected: (t?.gender || "girl") === v
		}, label)));
		const busy = view.tagBusy === c.id;
		const saveManual = async () => {
			if (view.tagBusy) return;
			view.tagBusy = c.id;
			render();
			try {
				const tags = {
					schema: 1,
					candidates: [tagForm(charInput.value)].filter(Boolean),
					character: "",
					copyright: tagForm(copyInput.value),
					gender: gender.value,
					looks: cleanTags(looksInput.value, 600),
					outfit: cleanTags(outfitInput.value, 400),
					manual: true
				};
				await checkImageTags(tags);
				const lore = await memberLoreText(c, await loreBooks(), contextBudget(state).analysis);
				tags.loreHash = loreHash(lore);
				c.imageTags = tags;
				c.imageTagError = "";
				await saveState(key);
				await storeImageTags(ctx.char.chaId, c, lore, tags);
			} catch (e) {
				c.imageTagError = e.message;
			} finally {
				view.tagBusy = "";
				render();
			}
		};
		const strip = sent.slice(0, 6);
		const drawing = view.profileBusy === c.id;
		const drawBtn = imageCfg.enabled ? h("button", {
			class: "pill primary",
			"data-t": "draw-profile",
			disabled: !imageReady() || !!view.profileBusy,
			onclick: async () => {
				if (view.profileBusy) return;
				view.profileBusy = c.id;
				c.imageTagError = "";
				render();
				try {
					await drawProfile(key, state, c);
				} catch (e) {
					c.imageTagError = e.message;
				} finally {
					view.profileBusy = "";
					render();
				}
			}
		}, drawing ? "프로필 그리는 중…" : "NAI로 프로필 그리기") : null;
		return h("section", {
			class: "card",
			"data-t": "image-tags"
		}, h("h3", {}, "사진", sent.length ? h("small", {}, `${sent.length}장`) : null), strip.length ? h("div", { class: "gal small" }, strip.map((item, i) => thumbButton(item, () => openViewer(sent.slice(), i), "gitem"))) : null, sent.length > strip.length ? h("button", {
			class: "pill top-gap",
			"data-t": "profile-gallery",
			onclick: () => go("list", {
				tab: "photos",
				galleryWho: c.id
			})
		}, "사진 모두 보기") : null, drawBtn ? h("div", { class: "actions flush" }, drawBtn) : null, strip.length ? h("div", { class: "sub top-gap" }, "사진을 눌러 크게 본 뒤 \"프로필로\"를 누르면 그 사진을 프로필로 씁니다.") : null, h("div", {
			class: "sub top-gap",
			"data-t": "tag-status"
		}, status), c.imageTagError ? h("div", {
			class: "notice flush",
			role: "alert"
		}, c.imageTagError) : null, imageCfg.enabled ? h("details", { "data-t": "tag-details" }, h("summary", { class: "analysis-summary" }, "사진 태그 고치기"), h("label", { class: "field flat" }, h("span", { class: "label" }, "캐릭터 태그 (NovelAI에서 확인)"), charInput), h("label", { class: "field flat" }, h("span", { class: "label" }, "작품 태그"), copyInput), h("label", { class: "field flat" }, h("span", { class: "label" }, "외형 태그"), looksInput), h("label", { class: "field flat" }, h("span", { class: "label" }, "기본 의상 태그 (옷 요청이 없을 때 입는 옷)"), outfitInput), h("label", { class: "field flat" }, h("span", { class: "label" }, "성별"), gender), h("div", { class: "actions" }, h("button", {
			class: "pill primary",
			"data-t": "tag-save",
			disabled: busy || !naiKey,
			onclick: saveManual
		}, busy ? "확인하는 중…" : "저장하고 NovelAI에서 확인"), h("button", {
			class: "pill",
			"data-t": "tag-regen",
			disabled: !imageReady() || !!view.analysis || !hasAnalyzedProfile(c),
			onclick: () => analyzeImageTags(state, [c], true)
		}, "태그 다시 분석"))) : null);
	}
	async function removeContact(state, contact) {
		state.removedNames = [...state.removedNames || [], normalize(contact.name)];
		state.contacts = state.contacts.filter((c) => c.id !== contact.id);
		for (const room of state.rooms) room.members = room.members.filter((id) => id !== contact.id);
		state.rooms = state.rooms.filter((r) => r.members.length > 0 && r.as !== contact.id);
		if (accountOf() === contact.id) view.account = "me";
		await saveState(view.key);
		go("list", { tab: "people" });
	}

//#endregion
//#region src/ui/screens/actions.js
	async function deleteMessages(room, ids) {
		const key = view.key, state = states.get(key);
		const drop = new Set(ids);
		const plan = state ? await memoryRewindChoice(key, state, room, drop, true) : null;
		if (plan) rewindMemory(state, plan, drop);
		else if (drop.has(room.memUpTo)) moveMemoryPointer(room, room.memUpTo, drop);
		const photos = room.msgs.filter((m) => drop.has(m.id) && m.photo?.id).map((m) => m.photo.id);
		room.msgs = room.msgs.filter((m) => !drop.has(m.id));
		if (!room.msgs.some((m) => m.failed)) room.error = "";
		await saveState(key);
		if (plan) for (const { room: r } of plan.rooms) void queueMemory(key, r.id, true, true);
		for (const id of photos) await deletePhotoData(id);
	}
	function trailingReplies(room) {
		const lastMine = room.msgs.map(typedMsg).lastIndexOf(true);
		return lastMine < 0 ? [] : room.msgs.slice(lastMine + 1);
	}
	function copyText(text) {
		const done = () => {
			view.notice = "복사했어요.";
		};
		if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(done).catch(() => fallback());
		return fallback();
		function fallback() {
			const area = h("textarea", { style: "position:fixed;opacity:0" });
			area.value = text;
			document.body.append(area);
			area.select();
			try {
				document.execCommand("copy");
				done();
			} catch {
				view.notice = "복사하지 못했어요.";
			}
			area.remove();
		}
	}
	function armedPill(label, armedLabel, onConfirm, testId, disabled = false) {
		const btn = h("button", {
			class: "pill",
			"data-t": testId,
			disabled,
			onclick: () => {
				if (btn.dataset.armed) return onConfirm();
				btn.dataset.armed = "1";
				btn.textContent = armedLabel;
				setTimeout(() => {
					delete btn.dataset.armed;
					btn.textContent = label;
				}, 4e3);
			}
		}, label);
		return btn;
	}
	function messageActions(state, room, m, index, busy) {
		const key = view.key;
		const mine = m.from === accountOf(), typed = typedMsg(m);
		const later = room.msgs.slice(index + 1);
		const isReply = !typed && trailingReplies(room).includes(m);
		const close = () => {
			view.msgMenu = "";
			render();
		};
		const resend = async () => {
			if (busyRooms.has(key + "|" + room.id)) return;
			await deleteMessages(room, later.map((x) => x.id));
			delete m.failed;
			close();
			await requestReply(key, room);
		};
		const reroll = async () => {
			if (busyRooms.has(key + "|" + room.id)) return;
			await deleteMessages(room, trailingReplies(room).map((x) => x.id));
			close();
			await requestReply(key, room);
		};
		return h("div", {
			class: `msg-acts${mine ? " me" : ""}`,
			"data-t": "msg-actions"
		}, m.text ? h("button", {
			class: "pill",
			"data-t": "msg-copy",
			onclick: async () => {
				await copyText(m.text);
				close();
			}
		}, "복사") : null, !typed ? h("button", {
			class: "pill",
			"data-t": "msg-edit",
			disabled: busy,
			onclick: () => {
				view.editMessage = {
					key,
					roomId: room.id,
					id: m.id,
					original: m.text || "",
					draft: m.text || "",
					error: "",
					saving: false
				};
				view.msgMenu = "";
				render();
			}
		}, "텍스트 수정") : null, mine && typed ? later.length ? armedPill("여기서 다시 보내기", `뒤의 ${later.length}개를 지우고 다시 받기`, resend, "msg-resend", busy) : h("button", {
			class: "pill",
			"data-t": "msg-resend",
			disabled: busy,
			onclick: resend
		}, "다시 보내기") : null, isReply ? armedPill("다시 받기", `답장 ${trailingReplies(room).length}개를 새로 받기`, reroll, "msg-reroll", busy) : null, armedPill("삭제", "한 번 더 누르면 삭제", async () => {
			await deleteMessages(room, [m.id]);
			close();
		}, "msg-delete", busy), later.length ? armedPill("여기부터 삭제", `이 메시지와 뒤의 ${later.length}개 삭제`, async () => {
			await deleteMessages(room, [m.id, ...later.map((x) => x.id)]);
			close();
		}, "msg-delete-from", busy) : null);
	}
	async function editBotMessageRaw(key, roomId, messageId, original, text) {
		if (typeof text !== "string" || !text.trim() || text.length > 5e4) throw new Error("수정할 내용을 1~50,000자 이내로 입력해 주세요.");
		const state = states.get(key), room = state?.rooms.find((r) => r.id === roomId);
		const m = room?.msgs.find((item) => item.id === messageId);
		if (!m || typedMsg(m) || !peopleOf(room).includes(m.from)) throw new Error("수정할 봇 메시지를 찾을 수 없어요.");
		const token = key + "|" + roomId;
		const ctx = await currentPlace();
		if (ctx?.key !== key || !states.get(key)?.rooms.includes(room) || !room.msgs.includes(m)) throw new Error("대화가 바뀌어 수정하지 않았어요.");
		if (busyRooms.has(token)) throw new Error("진행 중인 답장이 끝난 뒤 수정해 주세요.");
		if ((m.text || "") !== original) throw new Error("다른 작업에서 메시지가 바뀌었어요. 다시 열어 주세요.");
		const plan = text.trim() === (m.text || "").trim() ? null : await memoryRewindChoice(key, state, room, new Set([messageId]), false);
		if (busyRooms.has(token) || (m.text || "") !== original || !room.msgs.includes(m)) throw new Error("다른 작업에서 메시지가 바뀌었어요. 다시 열어 주세요.");
		const previous = {
			text: m.text,
			editedAt: m.editedAt,
			hadEditedAt: Object.hasOwn(m, "editedAt")
		};
		busyRooms.add(token);
		m.text = text.trim();
		m.editedAt = Date.now();
		try {
			await saveState(key);
		} catch (error) {
			m.text = previous.text;
			if (previous.hadEditedAt) m.editedAt = previous.editedAt;
			else delete m.editedAt;
			throw error;
		} finally {
			busyRooms.delete(token);
		}
		if (plan) {
			rewindMemory(state, plan, new Set());
			await saveState(key);
			for (const { room: r } of plan.rooms) void queueMemory(key, r.id, true, true);
		}
	}
	const editBotMessage = systemInstrument("edit", editBotMessageRaw);
	function messageEditPanel(room) {
		const edit = view.editMessage;
		if (!edit || edit.key !== view.key || edit.roomId !== room.id) return null;
		const input = h("textarea", {
			rows: 4,
			maxlength: 5e4,
			style: "display:block;width:100%;min-height:120px;box-sizing:border-box;resize:vertical;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:inherit;font:inherit",
			"aria-label": "봇 메시지 수정",
			"data-t": "msg-edit-input"
		});
		input.value = edit.draft;
		input.disabled = edit.saving;
		input.addEventListener("input", () => {
			edit.draft = input.value;
		});
		return h("section", {
			class: "card",
			"data-t": "msg-edit-panel"
		}, h("h3", {}, "봇 메시지 수정"), input, edit.error ? h("div", {
			class: "debug-bad",
			role: "alert",
			"data-t": "msg-edit-error"
		}, edit.error) : null, h("div", { class: "actions flush" }, h("button", {
			class: "pill primary",
			"data-t": "msg-edit-save",
			disabled: edit.saving,
			onclick: async () => {
				if (edit.saving) return;
				edit.saving = true;
				edit.error = "";
				render();
				try {
					await editBotMessage(edit.key, edit.roomId, edit.id, edit.original, edit.draft);
					if (view.editMessage === edit) view.editMessage = null;
				} catch (e) {
					edit.error = e.message;
				} finally {
					edit.saving = false;
					render();
				}
			}
		}, edit.saving ? "저장 중…" : "수정 저장"), h("button", {
			class: "pill",
			"data-t": "msg-edit-cancel",
			disabled: edit.saving,
			onclick: () => {
				view.editMessage = null;
				render();
			}
		}, "취소")));
	}
	const historyDeletes = new Set();
	const removableChatMemory = (x, roomIds, all) => x.type !== "fact" && !x.pinned && x.by !== "user" && (all || roomIds.has(x.roomId));
	async function deleteChatHistory(key, mode, roomId, deleteMemory = false) {
		const state = states.get(key);
		if (!state?.enabled || ![
			"clear",
			"delete",
			"all"
		].includes(mode)) throw new Error("채팅 상태가 바뀌었어요.");
		const rooms = mode === "all" ? [...state.rooms] : state.rooms.filter((r) => r.id === roomId);
		if (mode !== "all" && !rooms.length) throw new Error("삭제할 대화방을 찾을 수 없어요.");
		const ids = new Set(rooms.map((r) => r.id));
		if (historyDeletes.has(key) || photoRunning || rooms.some((r) => busyRooms.has(key + "|" + r.id) || memoryJobs.has(key + "|" + r.id)) || state.contacts.some((c) => memoryDeletes.has(JSON.stringify([key, c.id])))) throw new Error("진행 중인 작업이 끝난 뒤 삭제해 주세요.");
		const snapshots = rooms.map((r) => ({
			room: r,
			index: state.rooms.indexOf(r),
			msgs: r.msgs,
			unread: r.unread,
			error: r.error,
			memUpTo: r.memUpTo,
			memRuns: r.memRuns
		}));
		const memories = deleteMemory ? state.contacts.map((c) => ({
			contact: c,
			removed: memoryOf(c).filter((x) => removableChatMemory(x, ids, mode === "all"))
		})) : [];
		const photos = [...new Set(rooms.flatMap((r) => r.msgs.map((m) => m.photo?.id).filter(Boolean)))];
		historyDeletes.add(key);
		rooms.forEach((r) => busyRooms.add(key + "|" + r.id));
		if (mode === "clear") {
			const r = rooms[0];
			r.msgs = [];
			r.unread = 0;
			r.error = "";
			delete r.memUpTo;
			delete r.memRuns;
		} else state.rooms = state.rooms.filter((r) => !ids.has(r.id));
		for (const { contact, removed } of memories) {
			const drop = new Set(removed);
			contact.memory = memoryOf(contact).filter((x) => !drop.has(x));
		}
		try {
			await saveState(key);
		} catch (e) {
			for (const s of snapshots) {
				if (!state.rooms.includes(s.room)) state.rooms.splice(Math.min(s.index, state.rooms.length), 0, s.room);
				Object.assign(s.room, {
					msgs: s.msgs,
					unread: s.unread,
					error: s.error
				});
				if (s.memUpTo === undefined) delete s.room.memUpTo;
				else s.room.memUpTo = s.memUpTo;
				if (s.memRuns === undefined) delete s.room.memRuns;
				else s.room.memRuns = s.memRuns;
			}
			for (const { contact, removed } of memories) {
				const current = memoryOf(contact), have = new Set(current.map((x) => x.id));
				contact.memory = [...removed.filter((x) => !have.has(x.id)), ...current];
			}
			throw e;
		} finally {
			historyDeletes.delete(key);
			rooms.forEach((r) => busyRooms.delete(key + "|" + r.id));
		}
		const cleanup = await Promise.allSettled(photos.map(deletePhotoData));
		return {
			memoryCount: memories.reduce((n, x) => n + x.removed.length, 0),
			cleanupFailed: cleanup.some((r) => r.status === "rejected")
		};
	}
	function openChatDeletion(mode, room) {
		if (view.chatDelete?.saving) return;
		view.chatDelete = {
			key: view.key,
			mode,
			roomId: room?.id,
			deleteMemory: false,
			saving: false,
			error: ""
		};
		render();
	}
	function chatDeletionPanel(state) {
		const request = view.chatDelete;
		if (!request || request.key !== view.key) return null;
		const rooms = request.mode === "all" ? state.rooms : state.rooms.filter((r) => r.id === request.roomId);
		const roomIds = new Set(rooms.map((r) => r.id));
		const count = state.contacts.reduce((n, c) => n + memoryOf(c).filter((x) => removableChatMemory(x, roomIds, request.mode === "all")).length, 0);
		const title = request.mode === "all" ? "이 챗의 메신저 기록 삭제" : request.mode === "clear" ? "대화 내용 비우기" : "대화방 삭제";
		return h("div", {
			class: "crop-overlay",
			role: "dialog",
			"aria-modal": "true",
			"aria-label": title,
			"data-t": "chat-delete-dialog"
		}, h("section", { class: "card dialog-card" }, h("h3", {}, title), h("p", {}, "채팅을 지울 때 메모리도 함께 지울까요? 기본은 메모리 유지입니다."), h("label", { class: "check-row" }, h("input", {
			type: "checkbox",
			checked: request.deleteMemory,
			disabled: request.saving,
			"data-t": "chat-delete-memory",
			onchange: (e) => {
				request.deleteMemory = e.target.checked;
				render();
			}
		}), `자동 정리한 대화 메모리도 삭제 (${count}개)`), h("p", { class: "sub" }, request.mode === "all" ? "선택하면 이 챗의 자동 정리 항목을 삭제합니다. 설정 메모리·고정한 항목·직접 쓴 항목과 본편 요약은 유지합니다." : "선택하면 이 방에서 자동 정리한 항목만 삭제합니다. 다른 방의 항목과 설정 메모리·고정한 항목·직접 쓴 항목·본편 요약은 유지합니다. 출처가 없는 이전 항목도 유지합니다."), request.error ? h("div", {
			class: "notice",
			role: "alert",
			"data-t": "chat-delete-error"
		}, request.error) : null, h("div", { class: "actions flush" }, h("button", {
			class: "pill",
			disabled: request.saving,
			"data-t": "chat-delete-cancel",
			onclick: () => {
				view.chatDelete = null;
				render();
			}
		}, "취소"), h("button", {
			class: "pill danger",
			disabled: request.saving,
			"data-t": "chat-delete-confirm",
			onclick: async () => {
				if (request.saving || view.key !== request.key) return;
				request.saving = true;
				request.error = "";
				try {
					const work = deleteChatHistory(request.key, request.mode, request.roomId, request.deleteMemory);
					render();
					const result = await work;
					if (view.key !== request.key) return;
					view.chatDelete = null;
					view.notice = result.cleanupFailed ? "기록은 삭제했지만 일부 사진 파일을 정리하지 못했어요." : "";
					if (request.mode === "delete") go("list", {
						roomMenu: false,
						selecting: null,
						msgMenu: ""
					});
					else {
						view.roomMenu = false;
						render();
					}
				} catch (e) {
					request.error = e.message;
				} finally {
					request.saving = false;
					if (view.key === request.key) render();
				}
			}
		}, request.saving ? "삭제 중…" : request.deleteMemory ? "기록과 메모리 삭제" : "기록만 삭제"))));
	}
	function roomMenuPanel(state, room, busy) {
		return h("div", {
			class: "room-menu",
			"data-t": "room-menu-panel"
		}, h("button", {
			class: "pill",
			"data-t": "select-start",
			disabled: !room.msgs.length,
			onclick: () => {
				view.selecting = new Set();
				view.roomMenu = false;
				view.msgMenu = "";
				render();
			}
		}, "메시지 선택 삭제"), h("button", {
			class: "pill",
			"data-t": "room-clear",
			disabled: busy || !room.msgs.length,
			onclick: () => openChatDeletion("clear", room)
		}, "대화 내용 비우기"), h("button", {
			class: "pill danger",
			"data-t": "room-delete",
			disabled: busy,
			onclick: () => openChatDeletion("delete", room)
		}, room.type === "group" ? "단톡방 삭제" : "대화방 삭제"));
	}

//#endregion
//#region src/ui/screens/follow.js
	const botScope = (state) => state.enabled && view.setScope === "bot";
	const scopeSwitch = (state, note) => state.enabled ? [h("div", {
		class: "seg",
		role: "group",
		"aria-label": "설정 범위"
	}, [["chat", "이 채팅"], ["bot", "이 봇"]].map(([id, label]) => h("button", {
		"aria-pressed": String((view.setScope || "chat") === id),
		"data-t": "scope-" + id,
		onclick: () => {
			view.setScope = id;
			view.notice = "";
			render();
		}
	}, label))), botScope(state) && note ? h("div", { class: "seg-note" }, note) : null] : [];
	const CARD_PLACE = { style: " (사진 화면)" };
	function followCard(state, bot, card, title, ...kids) {
		if (bot) return h("section", {
			class: "card",
			"data-card": card
		}, h("h3", {}, title), ...kids);
		const on = follows(state, card);
		return h("section", {
			class: "card",
			"data-card": card
		}, h("h3", {}, title, h("label", { class: "follow" }, "봇 설정 따름", h("input", {
			type: "checkbox",
			checked: on,
			"aria-label": `${title} 봇 설정 따름`,
			"data-t": "follow-" + card,
			onchange: (e) => saveFollow(state, [card], e.target.checked)
		}), h("i"))), h("div", {
			class: "from-bot" + (on ? "" : " own"),
			"data-t": "follow-state-" + card
		}, on ? "이 봇 설정을 쓰는 중" : "이 채팅에서 직접 설정"), h("div", on ? {
			class: "followed",
			inert: true
		} : {}, ...kids));
	}
	function budgetBusy(key) {
		if (budgetSaves.has(key)) return "설정 분량을 저장 중이에요. 잠시 기다려 주세요.";
		if ([...busyRooms].some((k) => k.startsWith(key + "|")) || view.analysis || view.scanning || view.bioBusy) return "진행 중인 작업이 끝난 뒤 분량을 변경해 주세요.";
		return "";
	}
	async function saveFollow(state, cards, on) {
		const key = view.key, cfg = botCfgs.get(botIdOf(key));
		if (!cfg) return;
		if (on && cards.includes("budget") && !follows(state, "budget") && !sameValue(contextBudget(state), cfg.contextBudget)) {
			const busy = budgetBusy(key);
			if (busy) {
				view.notice = busy;
				render();
				return;
			}
		}
		const fields = cards.flatMap((card) => BOT_CARDS[card].fields);
		const old = {
			follow: state.follow,
			values: fields.map((f) => [f, state[f]]),
			stale: (state.contacts || []).map((c) => c.analysisStale)
		};
		const stale = setFollow(state, cfg, cards, on);
		try {
			await saveState(key);
			view.notice = stale ? "봇 설정의 분량을 따라요. 기존 인물은 필요할 때 다시 분석해 주세요." : "";
		} catch {
			state.follow = old.follow;
			for (const [f, v] of old.values) if (v === undefined) delete state[f];
			else state[f] = v;
			(state.contacts || []).forEach((c, i) => {
				if (old.stale[i] === undefined) delete c.analysisStale;
				else c.analysisStale = old.stale[i];
			});
			view.notice = "설정을 저장하지 못했어요.";
		}
		if (view.key === key) render();
	}
	function followStatus(state) {
		const cards = Object.keys(BOT_CARDS), own = cards.filter((c) => !follows(state, c));
		return h("div", {
			class: "follow-row",
			"data-t": "follow-status"
		}, h("div", { class: "follow-head" }, h("b", { "data-t": "follow-count" }, `봇 설정 따름 ${cards.length - own.length} / ${cards.length}개 카드`), h("button", {
			class: "pill" + (own.length ? " primary" : ""),
			"data-t": "follow-all",
			disabled: !own.length,
			onclick: () => openFollowAll(state)
		}, "모두 따르기"), h("button", {
			class: "pill",
			"data-t": "own-all",
			disabled: own.length === cards.length,
			onclick: () => saveFollow(state, cards, false)
		}, "모두 직접 설정")), h("div", { class: "sub" }, own.length ? "직접 설정: " + own.map((c) => BOT_CARDS[c].label + (CARD_PLACE[c] || "")).join(", ") : "모든 카드가 이 봇 설정을 따라요. 사진 화면의 카드도 함께 세요."));
	}
	function openFollowAll(state) {
		const cfg = botCfgs.get(botIdOf(view.key));
		if (!cfg) return;
		const own = Object.keys(BOT_CARDS).filter((c) => !follows(state, c));
		const changes = followChanges(state, cfg, own);
		if (!changes.length) return saveFollow(state, own, true);
		const stale = own.includes("budget") && contextBudget(state).analysis !== cfg.contextBudget.analysis && (state.contacts || []).some((c) => c.card);
		view.followAll = {
			key: view.key,
			cards: own,
			changes,
			stale
		};
		render();
	}
	function followAllPanel(state) {
		const request = view.followAll;
		if (!request || request.key !== view.key || view.screen !== "set-talk") return null;
		return h("div", {
			class: "crop-overlay",
			role: "dialog",
			"aria-modal": "true",
			"aria-label": "모두 따르기",
			"data-t": "follow-all-dialog"
		}, h("section", { class: "card dialog-card" }, h("h3", {}, "이 채팅의 모든 카드를 봇 설정 따름으로"), request.changes.map((line) => h("div", {
			class: "fact",
			"data-t": "follow-change"
		}, icon("info"), h("span", {}, line))), h("p", { class: "sub" }, `${request.stale ? "분량이 바뀌어 이 채팅의 인물 분석을 다시 확인해야 해요. " : ""}대화 기록과 메모리는 그대로예요.`), h("div", {
			class: "actions flush",
			style: "justify-content:flex-end"
		}, h("button", {
			class: "pill",
			"data-t": "follow-all-cancel",
			onclick: () => {
				view.followAll = null;
				render();
			}
		}, "취소"), h("button", {
			class: "pill primary",
			"data-t": "follow-all-confirm",
			onclick: () => {
				view.followAll = null;
				saveFollow(state, request.cards, true);
			}
		}, "모두 따르기"))));
	}
	function botActions(state) {
		return h("section", { class: "card" }, h("h3", {}, "이 봇 설정"), linkRow("이 채팅 설정으로 봇 설정 만들기", "지금 채팅의 대화 흐름·본편 연결·메모리·분량·그림체를 봇 설정으로 가져옵니다.", () => botFromChat(state), "bot-from-chat"), linkRow("이 봇의 모든 채팅을 봇 설정 따름으로", "누르면 바꿀 채팅을 고르는 화면이 열려요.", openBotApply, "bot-apply-open"));
	}
	async function botFromChat(state) {
		const key = view.key, cfg = botCfgs.get(botIdOf(key));
		if (!cfg) return;
		const next = copyValue(cfg);
		for (const { fields } of Object.values(BOT_CARDS)) for (const f of fields) next[f] = copyValue(chatValue(state, f));
		await commitBotCfg(next, "이 채팅 설정을 봇 설정으로 저장했어요.");
		if (view.key === key) render();
	}
	async function commitBotCfg(next, done = "") {
		const key = view.key, botId = botIdOf(key), cfg = botCfgs.get(botId);
		if (!cfg) return "failed";
		if (!sameValue(cfg.contextBudget, next.contextBudget)) {
			const rows = (await botChats(view.ctx)).filter((r) => r.state && follows(r.state, "budget"));
			if (rows.length) {
				go("bot-budget", { botBudget: {
					key,
					next,
					old: copyValue(cfg.contextBudget),
					rows,
					picked: new Set(rows.map((r) => r.key)),
					done,
					saving: false,
					error: ""
				} });
				return "picking";
			}
		}
		try {
			await saveBotCfg(botId, next);
			view.notice = done;
			return "saved";
		} catch {
			view.notice = "봇 설정을 저장하지 못했어요.";
			return "failed";
		}
	}
	function botBudgetScreen(state) {
		const job = view.botBudget;
		if (!job || job.key !== view.key) return chatSettingsScreen(state);
		const next = validateContextBudget(job.next.contextBudget), old = validateContextBudget(job.old);
		const recheck = next.analysis !== old.analysis;
		const rows = job.rows.map((r) => {
			const people = (r.state.contacts || []).filter((c) => c.card).length;
			return h("label", {
				class: "row pick",
				"data-t": "budget-row",
				"data-name": r.name
			}, h("span", { class: "mid" }, h("span", { class: "nm" }, r.name + (r.current ? " · 지금 연 채팅" : "")), h("span", { class: "pv" }, h("span", { class: "tx" }, `인물 ${people}명${recheck && people ? " · 분석 다시 확인" : ""}`))), h("input", {
				type: "checkbox",
				checked: job.picked.has(r.key),
				"data-t": "budget-pick",
				onchange: (e) => {
					if (e.target.checked) job.picked.add(r.key);
					else job.picked.delete(r.key);
					render();
				}
			}), h("span", { class: "check" }));
		});
		return [subHead("분량 적용할 채팅", "set-talk"), h("div", {
			class: "scroll",
			id: "scroll"
		}, h("div", {
			class: "notice",
			"data-t": "budget-summary"
		}, `봇 분량: ${settingText("contextBudget", old)} → ${settingText("contextBudget", next)}. 고른 채팅은 새 분량을 따르${recheck ? "고 인물 분석을 다시 확인해야 해요" : "요"}. 고르지 않은 채팅은 지금 분량을 "직접 설정"으로 유지해요.`), job.error ? h("div", {
			class: "notice",
			role: "alert",
			"data-t": "budget-error"
		}, job.error) : null, h("div", { class: "rows" }, rows), h("div", {
			class: "sub",
			style: "margin:8px 16px"
		}, "분량 저장만으로 모델을 부르지는 않아요. 분석은 각 채팅의 인물 프로필에서 다시 해요."), h("div", { class: "actions" }, h("button", {
			class: "pill",
			"data-t": "budget-cancel",
			onclick: () => go("set-talk", { botBudget: null })
		}, "취소"), h("button", {
			class: "pill primary",
			"data-t": "budget-apply",
			disabled: job.saving,
			onclick: () => applyBotBudget(job)
		}, job.saving ? "저장하는 중…" : `${job.picked.size}개 채팅에 적용`)))];
	}
	async function applyBotBudget(job) {
		if (job.saving) return;
		const busy = job.rows.map((r) => budgetBusy(r.key)).find(Boolean);
		if (busy) {
			job.error = busy;
			render();
			return;
		}
		job.saving = true;
		job.error = "";
		render();
		const before = job.rows.map((r) => ({
			follow: r.state.follow,
			budget: r.state.contextBudget,
			stale: (r.state.contacts || []).map((c) => c.analysisStale)
		}));
		for (const r of job.rows) {
			if (job.picked.has(r.key)) setChatBudget(r.state, job.next.contextBudget);
			else {
				r.state.follow = {
					...r.state.follow || {},
					budget: false
				};
				r.state.contextBudget = copyValue(job.old);
			}
		}
		try {
			await saveBotCfg(botIdOf(job.key), job.next);
		} catch {
			job.rows.forEach((r, i) => {
				const b = before[i];
				r.state.follow = b.follow;
				if (b.budget === undefined) delete r.state.contextBudget;
				else r.state.contextBudget = b.budget;
				(r.state.contacts || []).forEach((c, j) => {
					if (b.stale[j] === undefined) delete c.analysisStale;
					else c.analysisStale = b.stale[j];
				});
			});
			job.saving = false;
			job.error = "봇 설정을 저장하지 못했어요.";
			render();
			return;
		}
		const failed = (await Promise.allSettled(job.rows.map(writeChatState))).filter((x) => x.status === "rejected").length;
		const recheck = validateContextBudget(job.next.contextBudget).analysis !== validateContextBudget(job.old).analysis && job.picked.size;
		go("set-talk", {
			botBudget: null,
			notice: failed ? `${failed}개 채팅에 저장하지 못했어요. 다시 시도해 주세요.` : (job.done || "봇 분량을 저장했어요.") + (recheck ? " 고른 채팅의 인물은 필요할 때 다시 분석해 주세요." : "")
		});
	}
	const ownCards = (row, cards) => row.state ? [...cards].filter((c) => !follows(row.state, c)) : [];
	const defaultPicks = (rows, cards) => new Set(rows.filter((r) => ownCards(r, cards).length).map((r) => r.key));
	async function openBotApply() {
		const rows = await botChats(view.ctx), cards = new Set(Object.keys(BOT_CARDS));
		go("bot-apply", { botApply: {
			key: view.key,
			rows,
			cards,
			picked: defaultPicks(rows, cards),
			saving: false,
			error: ""
		} });
	}
	function botApplyScreen(state) {
		const job = view.botApply, cfg = botCfgs.get(botIdOf(view.key));
		if (!job || job.key !== view.key || !cfg) return chatSettingsScreen(state);
		const chip = (card) => h("button", {
			class: "chip" + (job.cards.has(card) ? " on" : ""),
			"aria-pressed": String(job.cards.has(card)),
			"data-t": "apply-card-" + card,
			onclick: () => {
				if (job.cards.has(card)) job.cards.delete(card);
				else job.cards.add(card);
				job.picked = defaultPicks(job.rows, job.cards);
				render();
			}
		}, (job.cards.has(card) ? "✓ " : "") + BOT_CARDS[card].label);
		const rows = job.rows.map((r) => {
			const own = ownCards(r, job.cards);
			const msgs = r.state ? (r.state.rooms || []).reduce((n, room) => n + (room.msgs || []).length, 0) : 0;
			const recheck = own.includes("budget") && contextBudget(r.state).analysis !== cfg.contextBudget.analysis && (r.state.contacts || []).some((c) => c.card);
			const desc = !r.state ? "Interlude를 쓴 적 없음" : own.length ? `메신저 메시지 ${msgs}개 · 바뀜: ${own.map((c) => BOT_CARDS[c].label).join(", ")}` : "고른 카드는 모두 봇 설정 따름";
			return h("label", {
				class: "row pick",
				"data-t": "apply-row",
				"data-name": r.name
			}, h("span", { class: "mid" }, h("span", { class: "nm" }, r.name + (r.current ? " · 지금 연 채팅" : ""), recheck ? h("span", {
				class: "scope scope-warn",
				"data-t": "apply-recheck"
			}, "분석 재확인") : null), h("span", { class: "pv" }, h("span", { class: "tx" }, desc))), h("input", {
				type: "checkbox",
				checked: job.picked.has(r.key),
				disabled: !own.length,
				"data-t": "apply-pick",
				onchange: (e) => {
					if (e.target.checked) job.picked.add(r.key);
					else job.picked.delete(r.key);
					render();
				}
			}), h("span", { class: "check" }));
		});
		return [subHead("채팅 고르기", "set-talk"), h("div", {
			class: "scroll",
			id: "scroll"
		}, h("div", { class: "notice" }, "고른 채팅에서 고른 카드만 봇 설정을 따르게 바뀌어요. 고르지 않은 카드와 대화 기록·메모리는 그대로예요."), job.error ? h("div", {
			class: "notice",
			role: "alert",
			"data-t": "apply-error"
		}, job.error) : null, h("section", { class: "card first" }, h("h3", {}, "바꿀 카드", h("small", {}, `${job.cards.size}개 선택`)), h("div", { class: "chips" }, Object.keys(BOT_CARDS).map(chip))), h("section", { class: "card" }, h("h3", {}, "바꿀 채팅", h("small", { "data-t": "apply-count" }, `${job.picked.size}개 선택`)), h("div", { class: "actions flush" }, h("button", {
			class: "pill",
			"data-t": "apply-all",
			onclick: () => {
				job.picked = defaultPicks(job.rows, job.cards);
				render();
			}
		}, "전체 선택"), h("button", {
			class: "pill",
			"data-t": "apply-none",
			onclick: () => {
				job.picked = new Set();
				render();
			}
		}, "전체 해제")), h("div", { class: "rows" }, rows), h("div", { class: "sub top-gap" }, "고른 카드에서 바뀌는 게 없는 채팅은 기본으로 빼 두었어요.")), h("div", { class: "actions" }, h("button", {
			class: "pill",
			"data-t": "apply-cancel",
			onclick: () => go("set-talk", { botApply: null })
		}, "취소"), h("button", {
			class: "pill primary",
			"data-t": "apply-confirm",
			disabled: job.saving || !job.picked.size || !job.cards.size,
			onclick: () => applyBotToChats(job)
		}, job.saving ? "바꾸는 중…" : `${job.picked.size}개 채팅 바꾸기`)))];
	}
	async function applyBotToChats(job) {
		if (job.saving) return;
		const cfg = botCfgs.get(botIdOf(job.key));
		const rows = job.rows.filter((r) => r.state && job.picked.has(r.key));
		if (job.cards.has("budget")) {
			const busy = rows.filter((r) => ownCards(r, job.cards).includes("budget")).map((r) => budgetBusy(r.key)).find(Boolean);
			if (busy) {
				job.error = busy;
				render();
				return;
			}
		}
		job.saving = true;
		job.error = "";
		render();
		let stale = false;
		for (const r of rows) stale = setFollow(r.state, cfg, ownCards(r, job.cards), true) || stale;
		const failed = (await Promise.allSettled(rows.map(writeChatState))).filter((x) => x.status === "rejected").length;
		go("set-talk", {
			botApply: null,
			notice: failed ? `${failed}개 채팅에 저장하지 못했어요. 다시 시도해 주세요.` : `${rows.length}개 채팅을 봇 설정 따름으로 바꿨어요.${stale ? " 분량이 바뀐 채팅의 인물은 필요할 때 다시 분석해 주세요." : ""}`
		});
	}

//#endregion
//#region src/ui/screens/allowance.js
	function budgetIntroPanel(state, combined = false) {
		if (!state.enabled || !combined && view.screen !== "list" || view.chatDelete || !combined && memoryIntroPanel(state) || contextBudget(state).mode !== "basic" && !(combined && (view.budgetIntro?.error || view.updateSettings?.budgetAttempt))) return null;
		const pick = view.budgetIntro ||= {
			mode: "standard",
			scope: "all",
			saving: false,
			error: ""
		};
		const amounts = (mode) => {
			const p = CONTEXT_PRESETS[mode];
			return `분석 ${p.analysis.toLocaleString()} · 설정 ${p.replyTotal.toLocaleString()} · 기록 ${p.roomHistory.toLocaleString()}자`;
		};
		const choice = ([mode, label]) => h("label", {
			class: "row pick",
			"data-t": "budget-intro-mode",
			"data-mode": mode
		}, h("span", { class: "mid" }, h("span", { class: "nm" }, label + (mode === "light" ? " (지금까지 쓰던 분량)" : "")), h("span", { class: "pv" }, h("span", { class: "tx" }, amounts(mode)))), h("input", {
			type: "radio",
			name: "budget-intro",
			checked: pick.mode === mode,
			onchange: () => {
				pick.mode = mode;
				render();
			}
		}), h("span", { class: "check" }));
		const scope = h("div", {
			class: "seg",
			role: "group",
			"aria-label": "적용 범위"
		}, [["bot", "이 봇만"], ["all", "모든 봇"]].map(([id, label]) => h("button", {
			"aria-pressed": String(pick.scope === id),
			"data-t": "budget-intro-" + id,
			onclick: () => {
				pick.scope = id;
				render();
			}
		}, label)));
		return h("div", {
			class: "crop-overlay",
			role: "dialog",
			"aria-modal": "true",
			"aria-label": "설정 분량 안내",
			"data-t": "budget-intro"
		}, h("section", { class: "card dialog-card" }, h("h3", {}, "설정 분량 이름이 바뀌었어요"), h("p", { class: "sub" }, `지금까지 쓰던 '기본'(인물 분석 ${CONTEXT_PRESETS.light.analysis.toLocaleString()}자)은 이제 '경량'이에요. 새 '기본'은 이전 '확장'과 같고, 새 '확장'은 그 두 배예요. 쓸 분량을 골라 주세요.`), h("div", { class: "rows" }, BUDGET_MODES.map(choice)), scope, h("div", { class: "fact" }, icon("info"), h("span", {}, pick.scope === "all" ? "모든 봇과 채팅 중 이전 기본을 쓰던 곳에 적용돼요. 직접 설정과 이전 확장(지금의 기본)은 그대로예요." : "이 봇과 이 봇의 채팅 중 이전 기본을 쓰던 곳에 적용돼요. 다른 봇은 열 때 다시 물어봐요.")), pick.mode === "light" ? null : h("div", { class: "fact" }, icon("info"), h("span", {}, "분량을 늘리면 답장마다 넣는 설정이 많아져 토큰이 늘어요. 이미 분석한 인물은 프로필에서 다시 분석해야 새 분량이 반영돼요. 지금 고르는 것만으로는 모델을 부르지 않아요.")), pick.error ? h("div", {
			class: "notice flush",
			role: "alert",
			"data-t": "budget-intro-error"
		}, pick.error) : null, combined ? null : h("div", {
			class: "actions flush",
			style: "justify-content:flex-end"
		}, h("button", {
			class: "pill primary",
			"data-t": "budget-intro-apply",
			disabled: pick.saving,
			onclick: () => applyBudgetChoice(view.key, pick)
		}, pick.saving ? "저장하는 중…" : "적용"))));
	}
	async function applyBudgetChoice(key, pick) {
		if (pick.saving) return false;
		const busy = budgetBusy(key);
		if (busy) {
			pick.error = busy;
			render();
			return false;
		}
		pick.saving = true;
		pick.error = "";
		render();
		const next = {
			mode: pick.mode,
			...CONTEXT_PRESETS[pick.mode]
		};
		const botId = botIdOf(key);
		let keys = [];
		try {
			keys = await risuai.pluginStorage.keys() || [];
		} catch {
			pick.saving = false;
			pick.error = "저장된 채팅 목록을 읽지 못했어요. 다시 눌러 주세요.";
			render();
			return false;
		}
		const chatPrefix = pick.scope === "all" ? STORE_PREFIX : STORE_PREFIX + botId + ":";
		const chatKeys = [...new Set([...keys.filter((k) => k.startsWith(chatPrefix)), ...[...states.keys()].filter((k) => k.startsWith(chatPrefix))])];
		const botIds = pick.scope === "all" ? [...new Set([botId, ...keys.filter((k) => k.startsWith(BOT_PREFIX)).map((k) => k.slice(BOT_PREFIX.length))])] : [botId];
		let failed = 0, changed = 0;
		for (const k of chatKeys) {
			try {
				const loaded = states.get(k), saved = loaded || await readJson(k);
				if (!saved || typeof saved !== "object" || contextBudget(saved).mode !== "basic") continue;
				const previousBudget = saved.contextBudget, hadBudget = Object.hasOwn(saved, "contextBudget");
				const previousMarks = (saved.contacts || []).map((c) => [
					c,
					Object.hasOwn(c, "analysisStale"),
					c.analysisStale
				]);
				setChatBudget(saved, next);
				try {
					if (loaded) await saveState(k);
					else await risuai.pluginStorage.setItem(k, JSON.stringify(saved));
				} catch (e) {
					if (hadBudget) saved.contextBudget = previousBudget;
					else delete saved.contextBudget;
					for (const [contact, hadMark, mark] of previousMarks) {
						if (hadMark) contact.analysisStale = mark;
						else delete contact.analysisStale;
					}
					throw e;
				}
				changed++;
			} catch {
				failed++;
			}
		}
		if (!failed) for (const id of botIds) {
			try {
				const cfg = await loadBotCfg(id);
				if (cfg.contextBudget.mode === "basic") {
					const updated = {
						...cfg,
						contextBudget: copyValue(next)
					};
					await risuai.pluginStorage.setItem(BOT_PREFIX + id, JSON.stringify({
						schema: 1,
						...updated
					}));
					botCfgs.set(id, updated);
				}
			} catch {
				failed++;
			}
		}
		if (!failed && pick.scope === "all") {
			try {
				const record = {
					...await loadBudgetRecord(),
					mode: pick.mode
				};
				await risuai.pluginStorage.setItem(BUDGET_KEY, JSON.stringify(record));
				setBudgetRecordLoad(Promise.resolve(record));
			} catch {
				failed++;
			}
		}
		pick.saving = false;
		if (failed) {
			pick.error = `${failed}곳에 저장하지 못했어요. 다시 눌러 주세요.`;
			if (view.key === key) render();
			return false;
		}
		view.budgetIntro = null;
		view.notice = `설정 분량을 ${BUDGET_LABELS[pick.mode]}(으)로 정했어요${changed ? ` · 채팅 ${changed}개` : ""}.` + (pick.mode === "light" ? "" : " 기존 인물은 필요할 때 프로필에서 다시 분석해 주세요.");
		if (view.key === key) render();
		return true;
	}
	async function applyMemoryIntroChoice(key, on) {
		const state = states.get(key);
		if (!state || view.memoryIntroSaving) return false;
		const old = {
			newMemory: state.newMemory,
			memoryOn: state.memoryOn,
			memoryIntro: state.memoryIntro
		};
		view.memoryIntroSaving = true;
		view.memoryIntroError = "";
		if (on) {
			state.newMemory = true;
			state.memoryOn = true;
		}
		state.memoryIntro = on ? "accepted" : "later";
		try {
			await saveState(key);
			return true;
		} catch {
			Object.assign(state, old);
			view.memoryIntroError = "메모리 설정을 저장하지 못했어요.";
			return false;
		} finally {
			view.memoryIntroSaving = false;
			if (view.key === key) render();
		}
	}
	function memoryIntroPanel(state, choose = null, selected = null) {
		if (!state.enabled || !choose && view.screen !== "list" || autoMemoryRecord?.choice || state.memoryIntro || state.newMemory === true || follows(state, "memory") || view.chatDelete) return null;
		const key = view.key;
		const answer = (on) => choose ? choose(on) : applyMemoryIntroChoice(key, on);
		return h("div", {
			class: "crop-overlay",
			role: "dialog",
			"aria-modal": "true",
			"aria-label": "새 메모리 안내",
			"data-t": "memory-intro"
		}, h("section", { class: "card dialog-card" }, h("h3", {}, "새 메모리 기능이 생겼어요"), h("p", { class: "sub" }, "켜면 인물들이 메신저에서 한 약속과 알게 된 일을 기억하고, 본편 요약에서 자기가 겪은 일을 가져와 답장에 씁니다."), h("div", { class: "fact" }, icon("info"), h("span", {}, "이 채팅에만 적용돼요. 나중에 설정 → 대화 → 메모리에서 언제든 바꿀 수 있어요.")), h("div", {
			class: "actions flush",
			style: "justify-content:flex-end"
		}, h("button", {
			class: "pill" + (selected === false ? " primary" : ""),
			"data-t": "memory-intro-later",
			"aria-pressed": selected === false ? "true" : "false",
			disabled: !!view.memoryIntroSaving,
			onclick: () => answer(false)
		}, "기존 설정 유지"), h("button", {
			class: "pill" + (selected === true ? " primary" : ""),
			"data-t": "memory-intro-on",
			"aria-pressed": selected === true ? "true" : "false",
			disabled: !!view.memoryIntroSaving,
			onclick: () => answer(true)
		}, "켜기"))));
	}
	function imageTagSummary(state) {
		if (!imageCfg.enabled) return null;
		const missing = missingImageTags(state);
		return h("section", { class: "card" }, h("h3", {}, "인물 사진 태그", scopeTag("chat")), h("div", { class: "sub" }, "인물 분석 때 캐릭터 태그와 외형 태그를 만들고, 캐릭터 태그가 NovelAI에 등록됐는지 확인합니다. 인물 프로필에서 고칠 수 있어요."), h("div", { class: "fact" }, icon("people"), h("span", { "data-t": "image-tag-count" }, `이 채팅의 인물 ${state.contacts.filter(hasAnalyzedProfile).length}명 중 태그 있음 ${state.contacts.filter(hasImageTags).length}명`)), missing.length ? h("button", {
			class: "pill",
			"data-t": "image-tags-missing",
			disabled: !imageReady() || !!view.analysis,
			onclick: () => analyzeImageTags(state, missing)
		}, `태그 없는 인물 ${missing.length}명 분석`) : null, unregisteredTags(state).length ? h("button", {
			class: "pill top-gap",
			"data-t": "image-tags-recheck",
			disabled: !imageReady() || !!view.analysis,
			onclick: () => recheckImageTags(state, unregisteredTags(state))
		}, `미등록 ${unregisteredTags(state).length}명 등록 다시 확인 (모델 호출 없음)`) : null);
	}
	function chatStyleSection(state, bot = false) {
		if (!imageCfg.enabled && !bot) return null;
		const key = view.key, cfg = botCfgs.get(botIdOf(key)) || copyValue(BOT_DEFAULTS), t = bot ? cfg : state;
		const styles = imageCfg.styles || [];
		const current = styleFor(t);
		const def = styles.find((s) => s.id === imageCfg.defaultStyle) || styles[0];
		const pick = h("select", {
			"aria-label": bot ? "이 봇의 그림체" : "이 채팅의 그림체",
			"data-t": "chat-style",
			onchange: async (e) => {
				if (bot) {
					try {
						await saveBotCfg(botIdOf(key), {
							...cfg,
							imageStyle: e.target.value
						});
					} catch {
						view.notice = "봇 설정을 저장하지 못했어요.";
					}
				} else {
					state.imageStyle = e.target.value;
					await saveState(key);
				}
				if (view.key === key) render();
			}
		}, h("option", {
			value: "",
			selected: !styles.some((s) => s.id === t.imageStyle)
		}, def ? `기본 프리셋 따르기 (${def.title})` : "그림체 없음"), styles.map((s) => h("option", {
			value: s.id,
			selected: s.id === t.imageStyle
		}, s.title)));
		const card = followCard(state, bot, "style", "그림체", h("label", { class: "field flat" }, h("span", { class: "label" }, bot ? "이 봇에 쓸 그림체" : "이 채팅에 쓸 그림체"), pick), h("div", { class: "sub" }, current ? `지금 ${bot ? "이 봇" : "이 채팅"}은 "${current.title}"로 그립니다.` : "그림체 프리셋이 없으면 모델 기본 그림체로 그립니다."));
		card.append(linkRow("그림체 프리셋 편집", "시작 준비 → 그림체 프리셋으로 이동", () => go("set-setup", { notice: "" }), "open-style-presets"));
		return card;
	}
	function stylePresetSection() {
		const styles = imageCfg.styles || [];
		const def = styles.find((s) => s.id === imageCfg.defaultStyle) || styles[0];
		return h("section", { class: "card" }, h("h3", {}, h("span", {}, "그림체 프리셋", scopeTag("all")), h("small", {}, `${styles.length}개`)), h("div", { class: "sub" }, "각 채팅은 설정 → 사진에서 프리셋을 고릅니다. 고르지 않은 채팅은 기본 프리셋으로 그려요."), h("div", { class: "rows top-gap" }, styles.map((s) => h("button", {
			class: "row flat",
			"data-t": "style-row",
			"data-name": s.title,
			onclick: () => go("style-edit", {
				styleId: s.id,
				notice: ""
			})
		}, h("span", { class: "mid" }, h("span", { class: "nm" }, s.title + (s.id === def?.id ? " · 기본" : "")), h("span", { class: "pv" }, h("span", { class: "tx" }, s.prompt || "(비어 있음)"))), icon("pen", 18)))), h("div", { class: "actions flush" }, h("button", {
			class: "pill",
			"data-t": "style-new",
			onclick: () => go("style-edit", {
				styleId: "",
				notice: ""
			})
		}, "새 프리셋")));
	}
	function styleEditScreen(state) {
		const styles = imageCfg.styles || [];
		const old = styles.find((s) => s.id === view.styleId);
		const title = h("input", {
			type: "text",
			value: old?.title || "",
			placeholder: "예: 수채화풍",
			"aria-label": "프리셋 이름",
			"data-t": "style-title"
		});
		const prompt = h("textarea", {
			rows: 6,
			placeholder: "예: 0.7::artist:..., anime coloring, soft lighting",
			"aria-label": "그림체 프롬프트",
			"data-t": "style-prompt"
		}, old?.prompt || "");
		const negative = h("textarea", {
			rows: 3,
			placeholder: "이 그림체에만 더할 네거티브 (없으면 비워 둠)",
			"aria-label": "추가 네거티브",
			"data-t": "style-negative"
		}, old?.negative || "");
		const isDefault = old && (imageCfg.defaultStyle === old.id || !styles.some((s) => s.id === imageCfg.defaultStyle) && styles[0] === old);
		const makeDefault = h("input", {
			type: "checkbox",
			checked: !!isDefault || !styles.length,
			"data-t": "style-default"
		});
		const save = async () => {
			const name = title.value.trim();
			if (!name) {
				view.notice = "프리셋 이름을 적어 주세요.";
				render();
				return;
			}
			const next = {
				id: old?.id || newId(),
				title: name.slice(0, 60),
				prompt: prompt.value.trim(),
				negative: negative.value.trim()
			};
			imageCfg.styles = old ? styles.map((s) => s.id === old.id ? next : s) : [...styles, next];
			if (makeDefault.checked) imageCfg.defaultStyle = next.id;
			await saveImageCfg();
			go("set-setup", { notice: `"${next.title}" 프리셋을 저장했어요.` });
		};
		const remove = old ? confirmButton("이 프리셋 삭제", async () => {
			imageCfg.styles = styles.filter((s) => s.id !== old.id);
			if (imageCfg.defaultStyle === old.id) imageCfg.defaultStyle = imageCfg.styles[0]?.id || "";
			await saveImageCfg();
			go("set-setup", { notice: `"${old.title}" 프리셋을 지웠어요. 이 프리셋을 쓰던 챗은 기본 프리셋으로 그립니다.` });
		}, "style-delete") : null;
		return [h("div", { class: "top line-b" }, backBtn(() => go("set-setup")), h("h1", { class: "small" }, old ? "그림체 수정" : "새 그림체"), h("button", {
			class: "pill primary",
			"data-t": "style-save",
			onclick: save
		}, "저장")), h("div", {
			class: "scroll",
			id: "scroll"
		}, view.notice ? h("div", {
			class: "notice",
			role: "alert"
		}, view.notice) : null, h("label", { class: "field" }, h("span", { class: "label" }, "이름"), title), h("label", { class: "field" }, h("span", { class: "label" }, "그림체 프롬프트 (사진 프롬프트 앞쪽에 붙음)"), prompt), h("label", { class: "field" }, h("span", { class: "label" }, "추가 네거티브"), negative), h("label", {
			class: "set",
			style: "padding:10px 16px"
		}, h("span", { class: "mid" }, "기본 프리셋으로 쓰기", h("small", {}, "그림체를 따로 고르지 않은 챗은 이 프리셋으로 그립니다.")), h("span", { class: "sw" }, makeDefault, h("i"))), remove ? h("div", { class: "field" }, remove) : null)];
	}

//#endregion
//#region src/ui/screens/modules.js
	async function openModules() {
		const ctx = view.ctx;
		go("modules", {
			moduleList: null,
			moduleNotice: ""
		});
		const cache = await readJson(ASSET_CACHE + ctx.char.chaId) || {};
		const mods = await readModules();
		view.moduleList = mods.map((m) => ({
			id: m.id,
			name: m.name,
			count: (m.assets || []).filter(isImageAsset).length
		})).sort((a, b) => b.count - a.count);
		view.moduleChosen = new Set(cache.selected || defaultModuleIds(ctx));
		render();
	}
	function modulesScreen(state) {
		const list = view.moduleList;
		const save = async () => {
			const ctx = view.ctx, key = ASSET_CACHE + ctx.char.chaId;
			const cache = await readJson(key) || {};
			cache.selected = [...view.moduleChosen];
			await risuai.pluginStorage.setItem(key, JSON.stringify(cache));
			const assets = await gatherAssets(ctx, true);
			repairAutoImages(state, assets);
			await saveState(view.key);
			go("set-setup", { notice: "" });
		};
		return [h("div", { class: "top line-b" }, backBtn(() => go("set-setup")), h("h1", { class: "small" }, "에셋 모듈"), h("button", {
			class: "pill primary",
			"data-t": "module-save",
			disabled: !list,
			onclick: save
		}, "저장")), h("div", {
			class: "scroll",
			id: "scroll"
		}, h("section", { class: "card first" }, h("div", { class: "sub" }, "프로필 사진을 찾을 모듈을 고릅니다. 기본은 이 캐릭터와 챗에 연결된 모듈이에요.")), list ? h("div", { class: "rows" }, list.map((m) => h("label", { class: "row pick" }, h("span", { class: "mid" }, h("span", { class: "nm" }, m.name), h("span", { class: "pv" }, h("span", { class: "tx" }, `이미지 ${m.count.toLocaleString()}개`))), h("input", {
			type: "checkbox",
			checked: view.moduleChosen.has(m.id),
			"aria-label": `${m.name} 사용`,
			"data-t": "module-item",
			"data-name": m.name,
			onchange: (e) => {
				if (e.target.checked) view.moduleChosen.add(m.id);
				else view.moduleChosen.delete(m.id);
			}
		}), h("span", { class: "check" })))) : h("div", { class: "hello" }, h("div", { class: "meta" }, "모듈 목록을 읽는 중입니다…")))];
	}

//#endregion
//#region src/ui/screens/time.js
	const TIME_SOURCE_TEXT = {
		nu: "상태창 [Nu|…] 줄",
		free: "상태창 날짜 칸",
		label: "상태창 Time 칸",
		var: "채팅 변수",
		pick: "고른 상태창 칸"
	};
	async function loadSessionInfo(key) {
		if (view.sessionLoading === key) return;
		view.sessionLoading = key;
		try {
			const ctx = await currentPlace();
			if (!ctx || ctx.key !== key) return;
			const message = ctx.chat?.message || [];
			const text = String(message.filter((m) => m.role === "char").at(-1)?.data || "");
			const all = text.split("\n").map((l) => l.trim()).filter((l) => l && l.length <= 160 && !/<[a-z!/]/i.test(l) && lineFields(l).length);
			const lines = all.filter((l, i) => statusLine(l) || i >= all.length - 3).slice(-8);
			view.sessionInfo = {
				key,
				chat: {
					message: message.slice(-40),
					scriptstate: ctx.chat?.scriptstate || {}
				},
				lines
			};
		} finally {
			if (view.sessionLoading === key) view.sessionLoading = "";
		}
		if (view.key === key && view.screen === "set-talk") render();
	}
	function timeCard(state, bot, t, set) {
		const key = view.key, info = view.sessionInfo?.key === key ? view.sessionInfo : null;
		if (!info) loadSessionInfo(key);
		const mode = Object.hasOwn(TIME_MODES, t.timeMode || "") ? t.timeMode : "off";
		const src = t.timeSource && TIME_SOURCES.some(([id]) => id === t.timeSource.kind) ? t.timeSource : { kind: "auto" };
		const found = info ? sessionTime(info.chat, src) : null;
		const where = (f) => f.source === "var" ? `${TIME_SOURCE_TEXT.var} ${f.name}` : `${TIME_SOURCE_TEXT[f.source]} · ${f.back ? `${f.back}개 앞 봇 메시지` : "마지막 봇 메시지"}`;
		const modeSelect = h("select", {
			"aria-label": "시간 반영",
			"data-t": "time-mode",
			onchange: (e) => set("timeMode", e.target.value)
		}, Object.entries(TIME_MODES).map(([id, m]) => h("option", {
			value: id,
			selected: id === mode,
			disabled: !bot && id === "session" && mode !== "session" && !found
		}, m.label)));
		const kids = [h("label", { class: "field flat" }, h("span", { class: "label" }, "모드"), modeSelect), h("div", {
			class: "sub",
			"data-t": "time-desc"
		}, TIME_MODES[mode].desc)];
		if (!bot) kids.push(!info ? h("div", {
			class: "sub",
			"data-t": "time-found"
		}, "세션 시간을 찾는 중…") : found ? h("div", {
			class: "sub",
			"data-t": "time-found"
		}, `찾은 시간: ${stampText(found)} · ${where(found)}`) : mode === "session" ? h("div", {
			class: "notice flush",
			"data-t": "time-found"
		}, "세션 시간을 찾지 못했어요. 지금은 끄기처럼 동작해요.") : h("div", {
			class: "sub",
			"data-t": "time-found"
		}, `이 채팅에서는 세션 시간을 찾지 못해 세션 시간을 고를 수 없어요. 최근 봇 메시지 ${SESSION_LOOKBACK}개에 상태창 시각이 없어요.`));
		if (mode === "session") {
			kids.push(h("label", { class: "field flat" }, h("span", { class: "label" }, "시간 출처"), h("select", {
				"aria-label": "시간 출처",
				"data-t": "time-source",
				onchange: (e) => set("timeSource", {
					...src,
					kind: e.target.value
				})
			}, TIME_SOURCES.map(([id, label]) => h("option", {
				value: id,
				selected: id === src.kind
			}, label)))));
			if (src.kind === "var") kids.push(timeVarList(info, src, set));
			if (src.kind === "pick") kids.push(timePickBox(info, src, set));
		}
		return followCard(state, bot, "time", "시간 반영", ...kids);
	}
	function timeVarList(info, src, set) {
		if (!info) return h("div", { class: "sub" }, "채팅 변수를 읽는 중…");
		const looks = ([name, value]) => /time|date|clock|day|hour|시간|날짜|시각|요일/i.test(name) || DATE_ONE.test(value) || /\d{1,2}\s*:\s*\d{2}/.test(value);
		const vars = Object.entries(info.chat.scriptstate || {}).filter(([k]) => k.startsWith("$")).map(([k, v]) => [k.slice(1), typeof v === "string" ? v : JSON.stringify(v) ?? ""]);
		vars.sort((a, b) => looks(b) - looks(a));
		const auto = sessionTime(info.chat, { kind: "auto" }), chosen = src.var ? variableTime(info.chat, src.var) : null;
		return h("div", {
			class: "top-gap",
			"data-t": "time-vars"
		}, vars.length ? h("div", { class: "rows" }, vars.map(([name, value]) => h("button", {
			class: "row flat",
			"aria-pressed": String(src.var === name),
			"data-t": "time-var",
			"data-name": name,
			onclick: () => set("timeSource", {
				...src,
				kind: "var",
				var: name
			})
		}, h("span", { class: "mid" }, h("span", { class: "nm" }, (src.var === name ? "✓ " : "") + name), h("span", { class: "pv" }, h("span", { class: "tx" }, value.slice(0, 80) || "(빈 값)")))))) : h("div", { class: "sub" }, "이 채팅에는 채팅 변수가 없어요."), src.var && !chosen ? h("div", {
			class: "notice flush",
			"data-t": "time-var-missing"
		}, `변수 ${src.var}에서 시간을 읽지 못했어요.`) : null, chosen && auto && stampText(chosen) !== stampText(auto) ? h("div", {
			class: "notice flush",
			"data-t": "time-var-differs"
		}, `최근 상태창(${stampText(auto)})과 값이 달라요.`) : null);
	}
	function timePickBox(info, src, set) {
		if (!info) return h("div", { class: "sub" }, "마지막 봇 메시지를 읽는 중…");
		const chip = (label, line, index) => {
			const on = src.prefix === linePrefix(line) && src.index === index;
			return h("button", {
				class: "chip" + (on ? " on" : ""),
				"aria-pressed": String(on),
				"data-t": "time-pick-chip",
				onclick: () => set("timeSource", {
					...src,
					kind: "pick",
					prefix: linePrefix(line),
					index
				})
			}, (on ? "✓ " : "") + (label.length > 30 ? label.slice(0, 30) + "…" : label));
		};
		return h("div", {
			class: "top-gap",
			"data-t": "time-pick"
		}, h("div", { class: "sub" }, src.prefix ? `"${src.prefix}"로 시작하는 줄의 ${src.index < 0 ? "줄 전체" : `${src.index + 1}번째 칸`}에서 읽어요.` : "마지막 봇 메시지에서 시간에 해당하는 칸을 눌러 주세요."), info.lines.length ? info.lines.map((line) => {
			const fields = lineFields(line);
			return h("div", { class: "chips top-gap" }, fields.map((f, i) => chip(f, line, i)), fields.length > 1 ? chip("줄 전체", line, -1) : null);
		}) : h("div", { class: "sub" }, "마지막 봇 메시지에서 고를 줄이 없어요."));
	}

//#endregion
//#region src/ui/screens/settings.js
	function applyMyPhoto(state) {
		const selected = state.mePhotos?.[view.me?.personaKey];
		view.me.image = selected && (view.meAssets || []).some((a) => a.path === selected) ? selected : view.me.defaultImage;
		const crop = state.mePhotoCrops?.[view.me.personaKey];
		view.me.imageCrop = validImageCrop(crop, view.me.image) ? { ...crop } : undefined;
	}
	function myPhotoScreen(state) {
		const key = view.key, personaKey = view.me.personaKey;
		const draft = { ...view.me };
		const choose = async (image, reset = false) => {
			const crop = reset ? null : await editProfileCrop(image, view.me.imageCrop);
			if (!reset && !crop || view.key !== key || view.me.personaKey !== personaKey) return;
			const old = state.mePhotos, oldCrops = state.mePhotoCrops;
			state.mePhotos = { ...state.mePhotos || {} };
			state.mePhotoCrops = { ...state.mePhotoCrops || {} };
			if (image) state.mePhotos[personaKey] = image;
			else delete state.mePhotos[personaKey];
			if (crop) state.mePhotoCrops[personaKey] = crop;
			else delete state.mePhotoCrops[personaKey];
			try {
				await saveState(key);
			} catch (e) {
				state.mePhotos = old;
				state.mePhotoCrops = oldCrops;
				view.notice = "프로필 사진을 저장하지 못했어요.";
				if (view.key === key) render();
				return;
			}
			if (view.key === key && view.me.personaKey === personaKey) {
				applyMyPhoto(state);
				render();
			}
		};
		return [h("div", { class: "top line-b" }, backBtn(() => go("me")), h("h1", { class: "small" }, "내 프로필 사진"), closeBtn()), h("div", {
			class: "scroll",
			id: "scroll"
		}, h("div", { class: "center" }, avatar(view.me, 96)), h("div", { class: "notice" }, "현재 페르소나의 프로필 이미지와 내장 에셋에서 고릅니다. 선택은 이 채팅의 해당 페르소나에만 저장됩니다."), view.notice ? h("div", {
			class: "notice",
			role: "alert"
		}, view.notice) : null, h("div", { class: "actions" }, h("button", {
			class: "pill",
			"data-t": "my-photo-adjust",
			disabled: !view.me.image,
			onclick: () => choose(view.me.image)
		}, "표시 영역 조정"), h("button", {
			class: "pill",
			"data-t": "my-photo-reset",
			onclick: () => choose("", true)
		}, "페르소나 기본 사진 사용")), h("div", { class: "field" }, assetGallery(draft, {
			contacts: [],
			candidates: []
		}, view.meAssets || [], (a) => choose(a.path))))];
	}
	async function saveContextBudgetRaw(key, input) {
		const state = states.get(key);
		if (!state) throw new Error("설정을 저장할 챗을 찾을 수 없어요.");
		if (budgetSaves.has(key)) throw new Error("설정 분량을 저장 중이에요. 잠시 기다려 주세요.");
		if ([...busyRooms].some((k) => k.startsWith(key + "|")) || view.analysis || view.scanning || view.bioBusy) throw new Error("진행 중인 작업이 끝난 뒤 분량을 변경해 주세요.");
		const next = validateContextBudget(input), old = state.contextBudget;
		const changed = contextBudget(state).analysis !== next.analysis;
		const previous = state.contacts.map((c) => c.analysisStale);
		budgetSaves.add(key);
		state.contextBudget = next;
		if (changed) {
			for (const c of state.contacts) if (c.card) c.analysisStale = true;
		}
		try {
			await saveState(key);
		} catch (error) {
			if (old === undefined) delete state.contextBudget;
			else state.contextBudget = old;
			state.contacts.forEach((c, i) => {
				if (previous[i] === undefined) delete c.analysisStale;
				else c.analysisStale = previous[i];
			});
			throw error;
		} finally {
			budgetSaves.delete(key);
		}
		return changed;
	}
	const saveContextBudget = systemInstrument("settings", saveContextBudgetRaw);
	function contextBudgetSection(state, bot = false) {
		const cfg = botCfgs.get(botIdOf(view.key)) || copyValue(BOT_DEFAULTS);
		const budget = bot ? validateContextBudget(cfg.contextBudget) : contextBudget(state);
		const card = followCard(state, bot, "budget", "설정 분량", h("button", {
			class: "set",
			"data-t": "open-context-settings",
			onclick: () => go("context-settings", {
				contextDraft: { ...budget },
				contextScope: bot ? "bot" : "chat",
				contextError: "",
				notice: ""
			})
		}, h("span", { class: "mid" }, `${BUDGET_LABELS[budget.mode]} · 인물 분석 ${budget.analysis.toLocaleString()}자`, h("small", {}, bot ? "이 봇 설정을 따르는 채팅에 적용돼요." : "봇 설명·페르소나·참가자 설정을 얼마나 읽을지 정합니다.")), icon("next", 18)));
		if (!bot && state.lastContextUsage?.length) card.append(h("details", {}, h("summary", { class: "analysis-summary" }, "최근 답장에 사용한 설정 분량"), h("pre", {
			class: "debug-raw",
			"data-t": "context-last-usage"
		}, contextUsageText(state.lastContextUsage))));
		return card;
	}
	function contextSettingsScreen(state) {
		const bot = view.contextScope === "bot" && state.enabled, cfg = botCfgs.get(botIdOf(view.key)) || copyValue(BOT_DEFAULTS);
		const draft = view.contextDraft || (view.contextDraft = { ...bot ? validateContextBudget(cfg.contextBudget) : contextBudget(state) });
		const selector = h("select", {
			"data-t": "context-mode",
			"aria-label": "설정 분량 모드",
			onchange: (e) => {
				view.contextDraft = e.target.value === "custom" ? {
					...draft,
					mode: "custom"
				} : validateContextBudget({ mode: e.target.value });
				view.contextError = "";
				render();
			}
		}, [...BUDGET_MODES, ["custom", "직접 설정"]].map(([value, text]) => h("option", {
			value,
			selected: (draft.mode === "basic" ? "light" : draft.mode) === value
		}, text)));
		const fields = CONTEXT_FIELDS.map(([key, label, min, max]) => {
			const input = h("input", {
				type: "number",
				min,
				max,
				step: 1,
				value: draft[key],
				disabled: draft.mode !== "custom",
				"data-t": "context-" + key,
				"aria-label": label
			});
			input.addEventListener("input", () => {
				draft[key] = input.value;
			});
			return h("label", { class: "field" }, h("span", { class: "label" }, `${label} (글자)`), input, h("small", { class: "sub" }, `${min.toLocaleString()}~${max.toLocaleString()}자`));
		});
		return [h("div", { class: "top line-b" }, backBtn(() => go("set-talk")), h("h1", { class: "small" }, bot ? "설정 분량 · 이 봇" : "설정 분량"), closeBtn()), h("div", {
			class: "scroll",
			id: "scroll"
		}, h("div", { class: "notice" }, (bot ? "이 봇 설정입니다. 봇 설정을 따르는 채팅에 적용돼요." : "이 채팅에만 적용됩니다.") + " 1.2.1부터 이전의 기본은 경량, 이전의 확장은 기본이 되었고, 확장은 기본의 두 배입니다. 메신저 기록은 1.0.3부터 줄 수 대신 글자 수로 셉니다. 분량을 늘리면 더 긴 설정을 읽지만 요청 비용과 시간이 늘 수 있습니다. 글자 수 기준이며 모델의 토큰 한도는 별도입니다. 최근 줄거리와 본편 메모리 분량은 대화 흐름에 따라 정해집니다."), h("div", { class: "notice" }, "인물 분석 분량을 바꾸면 기존 분석은 재확인이 필요합니다. 인물 프로필에서 다시 분석해 주세요. 분량 저장만으로 모델을 호출하지 않습니다."), view.contextError ? h("div", {
			class: "notice",
			role: "alert",
			"data-t": "context-error"
		}, view.contextError) : null, h("label", { class: "field" }, h("span", { class: "label" }, "모드"), selector), ...fields, h("div", { class: "actions" }, h("button", {
			class: "pill primary",
			"data-t": "context-save",
			disabled: !!view.contextSaving,
			onclick: async () => {
				if (view.contextSaving) return;
				const key = view.key;
				view.contextSaving = true;
				render();
				const picked = draft.mode === "basic" ? {
					...draft,
					mode: "light"
				} : draft;
				try {
					if (bot) {
						const status = await commitBotCfg({
							...cfg,
							contextBudget: validateContextBudget(picked)
						}, "봇 분량을 저장했어요.");
						if (status === "saved" && view.key === key) go("set-talk", { notice: view.notice });
						return;
					}
					const changed = await saveContextBudget(key, picked);
					if (view.key !== key) return;
					go("set-talk", { notice: changed ? "분량을 저장했어요. 기존 인물은 필요할 때 다시 분석해 주세요." : "분량을 저장했어요." });
				} catch (e) {
					view.contextError = e.message;
				} finally {
					view.contextSaving = false;
					render();
				}
			}
		}, "분량 저장"), h("button", {
			class: "pill",
			"data-t": "context-cancel",
			onclick: () => go("set-talk")
		}, "취소")), !bot && state.lastContextUsage?.length ? h("pre", {
			class: "debug-raw",
			"data-t": "context-usage"
		}, contextUsageText(state.lastContextUsage)) : null)];
	}
	const SCOPES = {
		chat: "이 채팅에만",
		bot: "이 봇 전체",
		all: "모든 봇"
	};
	const scopeTag = (scope) => scope ? h("span", {
		class: "scope scope-" + scope,
		"data-scope": scope
	}, SCOPES[scope]) : null;
	const subHead = (title, back = "settings") => h("div", { class: "top line-b" }, backBtn(() => go(back, { notice: "" })), h("h1", { class: "small" }, title), closeBtn());
	const menuBtn = (id, ic, title, sub) => h("button", {
		class: "set menu",
		"data-t": "menu-" + id,
		onclick: () => go("set-" + id, {
			notice: "",
			sessionInfo: null
		})
	}, icon(ic, 22), h("span", { class: "mid" }, title, h("small", {}, sub)), icon("next", 18));
	const linkRow = (title, desc, onclick, testId, scope) => h("button", {
		class: "set",
		"data-t": testId,
		onclick
	}, h("span", { class: "mid" }, h("span", {}, title, scopeTag(scope)), desc ? h("small", {}, desc) : null), icon("next", 18));
	const fieldLabel = (text, scope) => h("span", { class: "label" }, text, scopeTag(scope));
	const settingSelect = (label, value, options, onchange, testId, scope) => h("label", { class: "field flat" }, fieldLabel(label, scope), h("select", {
		"data-t": testId,
		onchange: (e) => onchange(e.target.value)
	}, options.map(([v, text]) => h("option", {
		value: v,
		selected: v === value
	}, text))));
	const noticeBox = () => view.notice ? h("div", {
		class: "notice",
		"data-t": "notice"
	}, view.notice) : null;
	const cardList = (cards) => {
		const list = cards.filter(Boolean);
		list[0]?.classList.add("first");
		return list;
	};
	function enabledToggle(state) {
		const fresh = !state.enabled && (follows(state, "memory") ? state.newMemory === true : !state.memoryIntro);
		return toggleRow("이 채팅에서 메신저 사용", fresh ? "버튼은 모든 채팅에 표시됩니다. 켜면 새 메모리도 함께 켜져요." : "버튼은 모든 채팅에 표시됩니다.", state.enabled, async (value) => {
			state.enabled = value;
			if (value && !state.memoryIntro && !follows(state, "memory")) {
				state.newMemory = true;
				state.memoryOn = true;
				state.memoryIntro = "enabled";
			}
			await saveState(view.key);
			syncFab();
			if (value) {
				if (state.contacts.length) {
					const assets = view.assets || await gatherAssets(view.ctx);
					if (repairAutoImages(state, assets)) await saveState(view.key);
					go("list", { tab: "chats" });
				} else openPicker();
			} else {
				go("settings", { notice: "" });
			}
		}, "enabled", "chat");
	}
	function settingsScreen(state) {
		const setup = menuBtn("setup", "gear", "시작 준비", "쓸 모델, NovelAI 연결, 그림 모델, 그림체 프리셋, 에셋 모듈");
		if (!state.enabled) {
			return [h("div", { class: "top line-b" }, h("img", {
				class: "logo",
				src: ICON_URI,
				alt: ""
			}), h("h1", { class: "small" }, "Interlude"), closeBtn()), h("div", {
				class: "scroll",
				id: "scroll"
			}, noticeBox(), h("section", { class: "card first" }, enabledToggle(state)), h("section", { class: "card" }, setup, menuBtn("manage", "box", "관리", "단어 사전, 백업·복원, 문제 해결")))];
		}
		return [h("div", { class: "top line-b" }, backBtn(() => go("list")), h("h1", { class: "small" }, "설정"), closeBtn()), h("div", {
			class: "scroll",
			id: "scroll"
		}, noticeBox(), h("section", { class: "card first" }, menuBtn("talk", "chat", "대화", "대화 흐름, 본편과 메신저, 메모리, 설정 분량"), menuBtn("photo", "photo", "사진", "사진 기능, 빈도, 사진 부탁, 그림체, 인물 사진 태그"), setup, menuBtn("manage", "box", "관리", "단어 사전, 기록 삭제, 백업·복원, 문제 해결")))];
	}
	function myProfileScreen(state) {
		const key = view.key, editing = view.meBioEdit === key;
		const bio = h("input", {
			type: "text",
			value: state.meBio || "",
			placeholder: "내 한줄 소개",
			"aria-label": "내 한줄 소개",
			"data-t": "my-bio"
		});
		const saveBio = async () => {
			const old = state.meBio;
			state.meBio = bio.value.trim();
			try {
				await saveState(key);
			} catch {
				state.meBio = old;
				view.notice = "한줄 소개를 저장하지 못했어요.";
				if (view.key === key) render();
				return;
			}
			if (view.key === key) {
				view.meBioEdit = "";
				view.notice = "";
				render();
			}
		};
		bio.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				saveBio();
			}
		});
		if (editing) requestAnimationFrame(() => bio.focus());
		return [h("div", { class: "top line-b" }, backBtn(() => go("list", {
			notice: "",
			meBioEdit: ""
		})), h("h1", { class: "small" }, "내 프로필"), closeBtn()), h("div", {
			class: "scroll",
			id: "scroll"
		}, h("div", { class: "cover" }), h("div", {
			class: "prof",
			"data-t": "me-card"
		}, h("span", { class: "ring" }, avatar(view.me, 104)), h("h2", { "data-t": "me-name" }, view.me?.name || "나"), h("div", { class: "st" }, view.me?.fromPersona ? "Risu 페르소나 이름 · 여기서는 바꿀 수 없어요" : "페르소나 이미지 없음 · 이름은 Risu에서 정해요"), editing ? h("div", { class: "inline-edit" }, bio, h("button", {
			class: "pill primary",
			"data-t": "my-bio-save",
			onclick: saveBio
		}, "저장"), h("button", {
			class: "pill",
			"data-t": "my-bio-cancel",
			onclick: () => {
				view.meBioEdit = "";
				render();
			}
		}, "취소")) : h("div", {
			class: "bio",
			"data-t": "my-bio-text"
		}, state.meBio || "아직 한줄 소개가 없어요.")), view.notice ? h("div", {
			class: "notice",
			role: "alert",
			"data-t": "notice"
		}, view.notice) : null, h("div", { class: "acts" }, h("button", {
			class: "act2",
			"data-t": "my-bio-edit",
			onclick: () => {
				view.meBioEdit = key;
				render();
			}
		}, h("span", { class: "round" }, icon("pen")), "소개 수정"), h("button", {
			class: "act2",
			"data-t": "my-photo",
			onclick: () => go("my-photo", { notice: "" })
		}, h("span", { class: "round" }, icon("camera")), "사진 변경"), switchButton("me")), h("section", { class: "card" }, h("h3", {}, "한줄 소개"), h("div", { class: "fact" }, icon("info"), h("span", {}, "인물들이 답장할 때 이 소개를 참고해요.")), h("div", { class: "fact" }, icon("chat"), h("span", {}, "한줄 소개와 사진은 이 채팅에만 적용돼요. 사진은 페르소나마다 따로 골라요."))), myTagCard(state))];
	}
	function myTagCard(state) {
		const key = view.key, t = state.meImageTags || {};
		const looks = h("textarea", {
			rows: 2,
			placeholder: "예: black hair, short hair, brown eyes",
			"aria-label": "외형 태그",
			"data-t": "my-tag-looks"
		}, t.looks || "");
		const outfit = h("textarea", {
			rows: 2,
			placeholder: "예: school uniform, black skirt",
			"aria-label": "기본 의상 태그",
			"data-t": "my-tag-outfit"
		}, t.outfit || "");
		const gender = h("select", {
			"aria-label": "성별",
			"data-t": "my-tag-gender"
		}, [
			["girl", "여성"],
			["boy", "남성"],
			["other", "기타"]
		].map(([v, l]) => h("option", {
			value: v,
			selected: (t.gender || "girl") === v
		}, l)));
		const save = async () => {
			const old = state.meImageTags;
			state.meImageTags = {
				schema: 1,
				character: "",
				copyright: "",
				gender: gender.value,
				looks: cleanTags(looks.value, 1e3),
				outfit: cleanTags(outfit.value, 1e3),
				manual: true
			};
			try {
				await saveState(key);
				view.notice = "사진 태그를 저장했어요.";
			} catch {
				if (old === undefined) delete state.meImageTags;
				else state.meImageTags = old;
				view.notice = "사진 태그를 저장하지 못했어요.";
			}
			if (view.key === key) render();
		};
		return h("section", {
			class: "card",
			"data-t": "my-tags"
		}, h("h3", {}, "사진 태그", h("small", {}, SCOPES.chat)), h("div", { class: "sub" }, "내가 그린 사진을 보내거나 사진에 함께 나올 때 이 태그로 그려요. 영어 Danbooru 태그로 써 주세요."), h("label", { class: "field flat" }, h("span", { class: "label" }, "외형 태그"), looks), h("label", { class: "field flat" }, h("span", { class: "label" }, "기본 의상 태그 (옷 요청이 없을 때 입는 옷)"), outfit), h("label", { class: "field flat" }, h("span", { class: "label" }, "성별"), gender), h("div", { class: "actions" }, h("button", {
			class: "pill primary",
			"data-t": "my-tag-save",
			onclick: save
		}, "저장")));
	}
	function chatSettingsScreen(state) {
		const key = view.key, bot = botScope(state);
		const cfg = botCfgs.get(botIdOf(key)) || copyValue(BOT_DEFAULTS);
		const t = bot ? cfg : state;
		const set = async (field, value) => {
			const change = field === "newMemory" && value ? {
				newMemory: true,
				memoryOn: true
			} : { [field]: value };
			if (bot) {
				try {
					await saveBotCfg(botIdOf(key), {
						...cfg,
						...change
					});
				} catch {
					view.notice = "봇 설정을 저장하지 못했어요.";
				}
			} else {
				Object.assign(state, change);
				if (field === "newMemory") state.memoryIntro ||= "settings";
				await saveState(key);
			}
			if (view.key === key) render();
		};
		const mode = modeOf(t);
		const modeSelect = h("select", {
			"aria-label": "대화 흐름",
			"data-t": "chat-mode",
			onchange: (e) => set("mode", e.target.value)
		}, Object.entries(MODES).map(([id, m]) => h("option", {
			value: id,
			selected: id === mode
		}, m.label)));
		const sourceSelect = h("select", {
			"aria-label": "본편 메모리를 가져올 곳",
			"data-t": "story-source",
			disabled: t.storyIn === false || !t.useSummary,
			onchange: (e) => set("storySource", e.target.value)
		}, STORY_SOURCES.map(([id, label]) => h("option", {
			value: id,
			selected: id === (t.storySource || "auto")
		}, label)));
		const last = state.lastStoryMemory;
		const lastText = !last ? "아직 답장에서 본편 메모리를 쓰지 않았어요." : last.source ? `최근 답장: ${sourceLabel(last.source)} · 요약 ${last.total}개 중 ${last.used}개 사용` : "최근 답장에서 쓸 요약을 찾지 못했어요. 본편 채팅에 요약 기능이 켜져 있는지 확인해 주세요.";
		const people = state.contacts.filter((c) => memoryOf(c).length);
		const count = people.reduce((n, c) => n + memoryOf(c).length, 0);
		const pending = state.rooms.filter((r) => roomMembers(state, r).length && memoryPending(r).length);
		const tidying = state.rooms.some((r) => memoryJobs.has(key + "|" + r.id));
		return [subHead("대화"), h("div", {
			class: "scroll",
			id: "scroll"
		}, noticeBox(), ...scopeSwitch(state, "이 봇의 채팅 중 봇 설정을 따르는 카드에 바로 적용돼요."), bot ? null : followStatus(state), ...cardList([
			bot ? null : h("section", { class: "card" }, h("h3", {}, "메신저"), enabledToggle(state)),
			followCard(state, bot, "flow", "대화 흐름", h("label", { class: "field flat" }, h("span", { class: "label" }, "흐름"), modeSelect), h("div", {
				class: "sub",
				"data-t": "chat-mode-desc"
			}, MODES[mode].desc)),
			followCard(state, bot, "link", "본편과 메신저", toggleRow("본편 → 메신저", "본편 줄거리와 본편 메모리를 답장에 씁니다. 끄면 설정, 메모리, 메신저 대화만 봅니다.", t.storyIn !== false, (value) => set("storyIn", value), "story-in"), toggleRow("메신저 → 본편", "메신저 대화와 대화 메모리를 본편 요청에 함께 보냅니다.", t.inject, (value) => set("inject", value), "inject")),
			followCard(state, bot, "memory", "메모리", toggleRow("메모리 사용", "켜면 저장된 기억을 답장에 쓰고, 메신저 대화도 자동으로 정리해 기억합니다. 끄면 본편 요약만 쓰며 저장된 메모리는 유지합니다.", !!t.newMemory, (value) => set("newMemory", value), "new-memory"), t.newMemory ? toggleRow("본편 메모리 사용", "본편 채팅의 요약에서 이 방 인물이 겪은 일을 가져옵니다. 모델을 따로 부르지 않아요.", t.useSummary, (value) => set("useSummary", value), "summary") : toggleRow("본편 요약 반영", "최근 줄거리 밖의 사건을 본편 채팅의 요약에서 가져와 답장에 씁니다.", t.useSummary, (value) => set("useSummary", value), "summary"), t.newMemory ? h("label", { class: "field flat" }, h("span", { class: "label" }, "가져올 곳"), sourceSelect) : null, t.newMemory && !bot ? h("div", {
				class: "sub",
				"data-t": "story-memory-status"
			}, state.storyIn === false ? "본편 → 메신저가 꺼져 있어 쓰지 않아요." : lastText) : null, t.newMemory ? h("details", { "data-t": "memory-details" }, h("summary", { class: "sub" }, "세부 설정"), toggleRow("메모리 자동 정리", `한 방에 새 메시지가 ${MEMORY_EVERY}개 쌓이면 답장 뒤에 모델을 한 번 불러 기억할 것을 정리합니다. 끄면 저장된 기억만 사용합니다.`, !!t.memoryOn, (value) => set("memoryOn", value), "memory-on")) : null),
			timeCard(state, bot, t, set),
			contextBudgetSection(state, bot),
			followCard(state, bot, "polish", "캐릭터 계정에서 말투로 다듬기", toggleRow("말투로 다듬기", "켜면 캐릭터 계정에서 보내기를 누를 때 그 캐릭터 말투로 다듬은 문장이 입력창에 들어가요. 확인하거나 고친 뒤 다시 누르면 보내요. 끄면 쓴 그대로 보내고, 캐릭터는 그 말투를 따라 하지 않고 한 일과 약속만 기억해요.", t.polish !== false, (value) => set("polish", value), "polish")),
			!bot && state.newMemory ? h("section", { class: "card" }, h("h3", {}, "대화 메모리"), h("div", { class: "fact" }, icon("people"), h("span", { "data-t": "memory-count" }, `인물 ${people.length}명 · 메모리 ${count}개`)), h("div", { class: "sub" }, "설정 메모리와 대화 메모리는 각 인물의 프로필에서 보고 고칠 수 있어요."), state.memoryError ? h("div", {
				class: "notice flush",
				role: "alert",
				"data-t": "memory-error"
			}, "메모리 정리 실패: " + state.memoryError) : null, pending.length ? h("button", {
				class: "pill top-gap",
				"data-t": "memory-tidy",
				disabled: tidying,
				onclick: () => {
					for (const r of pending) queueMemory(key, r.id, true);
					render();
				}
			}, tidying ? "정리하는 중…" : `지금 정리 (방 ${pending.length}개, 모델 ${pending.length}회)`) : null) : null,
			bot ? botActions(state) : null
		]))];
	}
	function photoSettingsScreen(state) {
		const key = view.key;
		if (botScope(state)) return [subHead("사진"), h("div", {
			class: "scroll",
			id: "scroll"
		}, noticeBox(), ...scopeSwitch(state), ...cardList([chatStyleSection(state, true)]), h("div", { class: "notice" }, "사진 기능·빈도·사진 부탁은 모든 봇 공통이라 \"이 채팅\" 화면에서 바꿔요."))];
		const save = async () => {
			await saveImageCfg();
			if (view.key === key) render();
		};
		const missing = missingImageTags(state);
		const asking = view.imageAsk && missing.length && imageReady();
		return [subHead("사진"), h("div", {
			class: "scroll",
			id: "scroll"
		}, noticeBox(), ...scopeSwitch(state), h("section", { class: "card first" }, h("h3", {}, "사진 받기"), toggleRow("사진 기능 사용", "인물이 상황에 맞게 사진을 보냅니다. 사진 한 장마다 NovelAI 생성 1회를 씁니다.", imageCfg.enabled, async (on) => {
			imageCfg.enabled = on;
			view.imageAsk = on && missingImageTags(state).length > 0;
			await save();
		}, "image-enabled", "all"), asking ? h("div", {
			class: "notice flush",
			"data-t": "image-ask"
		}, `사진 태그가 없는 인물 ${missing.length}명이 있어요. 지금 분석할까요? (보조 모델 ${missing.length}회 호출, 이미 태그가 있는 인물은 건너뜁니다)`, h("div", { class: "actions flush" }, h("button", {
			class: "pill primary",
			"data-t": "image-ask-yes",
			onclick: () => analyzeImageTags(state, missing)
		}, "분석하기"), h("button", {
			class: "pill",
			"data-t": "image-ask-no",
			onclick: () => {
				view.imageAsk = false;
				render();
			}
		}, "나중에"))) : null, settingSelect("보내는 빈도", imageCfg.freq, Object.entries(PHOTO_FREQ).map(([k, v]) => [k, v[0]]), (v) => {
			imageCfg.freq = v;
			save();
		}, "image-freq", "all"), settingSelect("사진 부탁", imageCfg.ask || "normal", Object.entries(PHOTO_ASK).map(([k, v]) => [k, v[0]]), (v) => {
			imageCfg.ask = v;
			save();
		}, "image-ask-mode", "all")), h("section", { class: "card" }, h("h3", {}, "사진 보내기"), toggleRow("보낸 사진을 모델에게도 보여 주기", "켜면 방금 보낸 사진을 답장 모델에 이미지로도 함께 보내요. 이미지를 볼 수 있는 모델을 쓸 때만 켜 주세요. 끄면 사진 설명만 보내요.", imageCfg.seePhotos === true, async (on) => {
			imageCfg.seePhotos = on;
			await save();
		}, "see-photos", "all")), chatStyleSection(state), imageTagSummary(state))];
	}
	function setupSettingsScreen(state) {
		const key = view.key;
		const save = async () => {
			await saveImageCfg();
			if (view.key === key) render();
		};
		const keyInput = h("input", {
			type: "password",
			value: naiKey,
			placeholder: "pst-로 시작하는 키",
			autocomplete: "off",
			"aria-label": "NovelAI API 키",
			"data-t": "nai-key"
		});
		const check = async () => {
			setNaiKey(keyInput.value.trim());
			await risuai.setArgument("nai_key", naiKey);
			view.keyStatus = "확인하는 중…";
			render();
			try {
				if (!naiKey) throw new Error("키를 입력해 주세요.");
				await naiSuggest("saber (fate)");
				view.keyStatus = "연결됐어요.";
			} catch (e) {
				view.keyStatus = e.message;
			}
			render();
		};
		const negative = h("textarea", {
			rows: 2,
			"aria-label": "공통 네거티브 프롬프트",
			"data-t": "image-negative"
		}, imageCfg.negative);
		negative.addEventListener("change", () => {
			imageCfg.negative = negative.value.trim();
			save();
		});
		const slotSelect = h("select", {
			"aria-label": "쓸 모델",
			"data-t": "model-slot",
			onchange: async () => {
				view.modelSlot = slotSelect.value;
				await risuai.setArgument("model_slot", view.modelSlot);
			}
		}, h("option", {
			value: "aux",
			selected: view.modelSlot !== "main"
		}, "Risu 보조 모델"), h("option", {
			value: "main",
			selected: view.modelSlot === "main"
		}, "Risu 메인 모델"));
		return [subHead("시작 준비"), h("div", {
			class: "scroll",
			id: "scroll"
		}, h("div", { class: "notice" }, "처음 한 번 정해 두면 되는 설정이에요."), h("section", { class: "card first" }, h("h3", {}, "쓸 모델"), h("div", { class: "sub" }, "메신저 답장과 분석에 모두 씁니다. 모델은 Risu 설정에서 정해요.", scopeTag("all")), h("div", { class: "model" }, slotSelect)), h("section", { class: "card" }, h("h3", {}, "화면"), settingSelect("테마", uiCfg.theme, THEMES, async (v) => {
			const old = uiCfg.theme;
			setUiCfg({ theme: v });
			applyTheme();
			try {
				await risuai.pluginStorage.setItem(UI_SETTINGS, JSON.stringify(uiCfg));
			} catch {
				setUiCfg({ theme: old });
				applyTheme();
				view.notice = "테마를 저장하지 못했어요.";
			}
			render();
		}, "ui-theme", "all"), h("div", { class: "sub" }, "기기 설정 따르기는 휴대폰·PC의 다크 모드 설정에 맞춰 바뀌어요.")), h("section", { class: "card" }, h("h3", {}, "NovelAI 연결"), h("div", { class: "sub" }, "키는 Interlude 플러그인 설정값으로만 저장합니다.", scopeTag("all")), h("div", { class: "model" }, keyInput), h("div", { class: "actions flush" }, h("button", {
			class: "pill primary",
			"data-t": "nai-key-save",
			onclick: check
		}, "저장하고 확인")), view.keyStatus ? h("div", {
			class: "sub top-gap",
			role: "status",
			"data-t": "nai-key-status"
		}, view.keyStatus) : null), h("section", { class: "card" }, h("h3", {}, "그림"), settingSelect("모델", imageCfg.model, NAI_MODELS, (v) => {
			imageCfg.model = v;
			save();
		}, "image-model", "all"), h("div", { class: "sub" }, "모델마다 아는 캐릭터가 달라요. 모델을 바꾸면 다음 사진부터 등록 여부를 다시 확인합니다."), settingSelect("크기", imageCfg.size, Object.entries(PHOTO_SIZES).map(([k, v]) => [k, `${v[2]} ${v[0]}×${v[1]}`]), (v) => {
			imageCfg.size = v;
			save();
		}, "image-size", "all"), h("label", { class: "field flat" }, fieldLabel("공통 네거티브 프롬프트 (모든 그림체에 붙음)", "all"), negative)), stylePresetSection(), h("section", { class: "card" }, h("h3", {}, "프로필 사진"), linkRow("에셋 모듈 고르기", "프로필 사진을 찾을 모듈을 정합니다.", openModules, "open-modules", "bot")), view.notice ? h("div", {
			class: "notice",
			"data-t": "notice"
		}, view.notice) : null)];
	}
	function manageSettingsScreen(state) {
		const msgs = state.rooms.reduce((n, r) => n + r.msgs.length, 0);
		return [subHead("관리"), h("div", {
			class: "scroll",
			id: "scroll"
		}, noticeBox(), ...cardList([
			h("section", { class: "card" }, h("h3", {}, "단어 사전"), linkRow(`단어 ${termDict.length}개`, "고유명사의 한글 표기를 확인하고 고칩니다.", () => go("terms"), "open-terms", "bot")),
			state.enabled ? h("section", { class: "card" }, h("h3", {}, "저장소"), h("div", { class: "fact" }, icon("box"), h("span", { "data-t": "storage" }, `대화방 ${state.rooms.length}개 · 메시지 ${msgs}개`), scopeTag("chat")), h("div", { class: "sub" }, "삭제 전에 자동 정리한 대화 메모리도 지울지 선택합니다. 기본은 메모리 유지이며 설정 메모리, 고정하거나 직접 쓴 항목은 남아요."), h("button", {
				class: "set danger",
				"data-t": "clear-all",
				onclick: () => openChatDeletion("all")
			}, "이 채팅의 메신저 기록 삭제")) : null,
			h("section", { class: "card" }, h("h3", {}, "백업·복원"), linkRow("백업·복원", "메신저 기록을 파일로 저장하거나 불러옵니다.", () => go("set-backup", { notice: "" }), "menu-backup")),
			h("section", { class: "card" }, h("h3", {}, "문제 해결"), linkRow("시스템 로그", "분석·메시지·사진·저장 작업과 설치 플러그인 정보를 확인하고 전체 복사합니다.", openSystemLog, "open-system-log"), linkRow("이전 답장 진단", "기존 답장 진단 30건 보기", openDebug, "open-debug-settings"))
		]))];
	}
	function backupSettingsScreen(state) {
		return [subHead("백업·복원", "set-manage"), h("div", {
			class: "scroll",
			id: "scroll"
		}, backupSection(state))];
	}

//#endregion
//#region src/ui/styles.js
	const CSS = `
.crop-overlay{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:12px}
.card.dialog-card{width:100%;max-width:420px;max-height:85vh;overflow:auto;background:var(--bg);color:var(--text);border-top:0;border-radius:16px;padding:18px;box-shadow:var(--shadow)}.check-row{display:flex;align-items:flex-start;gap:10px;padding:8px 0;cursor:pointer}.check-row input{flex:none;width:18px;height:18px;margin:2px 0 0}
.crop-panel{background:var(--bg);color:var(--text);width:min(100%,380px);max-height:100%;overflow:auto;border-radius:16px;padding:18px;box-shadow:var(--shadow)}
.crop-panel h2{margin:0 0 8px;font-size:19px}.crop-stage{display:block;width:min(100%,280px);height:auto;aspect-ratio:1;border-radius:50%;margin:14px auto;touch-action:none;cursor:grab;background:var(--bg2);outline:2px solid var(--line)}
.crop-stage:active{cursor:grabbing}.crop-small{width:64px;height:64px;flex:none;border-radius:50%;background:var(--bg2)}.crop-preview{display:flex;align-items:center;gap:14px}.crop-panel input[type=range]{width:100%;touch-action:pan-x}.crop-panel .actions{justify-content:flex-end}
:root{color-scheme:light;--bg:#fff;--bg2:#f0f2f5;--hover:#f2f2f2;--line:#ced0d4;--text:#050505;--sub:#65676b;--other:#e4e6eb;--blue:#0084ff;--green:#31a24c;--red:#e41e3f;--scrim:rgba(17,24,39,.22);--shadow:0 12px 40px rgba(0,0,0,.3)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#242526;--bg2:#3a3b3c;--hover:#3a3b3c;--line:#3e4042;--text:#e4e6eb;--sub:#b0b3b8;--other:#3e4042;--blue:#2e89ff;--green:#45bd62;--red:#ff6b81;--scrim:rgba(0,0,0,.4);--shadow:0 12px 40px rgba(0,0,0,.6)}}
:root[data-theme=dark]{color-scheme:dark;--bg:#242526;--bg2:#3a3b3c;--hover:#3a3b3c;--line:#3e4042;--text:#e4e6eb;--sub:#b0b3b8;--other:#3e4042;--blue:#2e89ff;--green:#45bd62;--red:#ff6b81;--scrim:rgba(0,0,0,.4);--shadow:0 12px 40px rgba(0,0,0,.6)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:transparent!important;overflow:hidden;font:15px/1.34 Roboto,"Noto Sans KR","Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:var(--text)}
button,input,textarea,select{font:inherit;color:inherit}
button{background:none;border:0;padding:0;cursor:pointer}button:disabled{opacity:.5;cursor:default}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.scrim{position:fixed;inset:0;background:var(--scrim)}
.win{position:fixed;right:24px;bottom:24px;width:380px;height:min(700px,calc(100% - 136px));background:var(--bg);border-radius:16px;box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden}
@media (max-width:560px){.win{left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom,0px));width:auto;height:calc(100% - 128px)}}
.top{display:flex;align-items:center;gap:6px;min-height:60px;padding:8px 10px;flex:none}
.top.line-b{box-shadow:0 1px 2px rgba(0,0,0,.14);z-index:1}
h1{flex:1;min-width:0;margin:0 2px 0 6px;font-size:24px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}h1.small{font-size:17px}
.logo{width:32px;height:32px;margin-left:4px}
.ico{display:inline-block;flex:none;line-height:0}
.round{flex:none;width:40px;height:40px;border-radius:50%;background:var(--bg2);display:grid;place-items:center}.round.primary{background:var(--blue);color:#fff}
.plain{flex:none;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;color:var(--blue)}.plain:hover{background:var(--hover)}
.scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.search{margin:0 12px 8px;display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;border-radius:20px;background:var(--bg2);color:var(--sub);flex:none}
.search input{flex:1;min-width:0;border:0;background:none;outline:0;color:var(--text);font-size:16px}.search input::placeholder{color:var(--sub)}
.av{position:relative;flex:none;display:inline-grid;place-items:center;border-radius:50%;background:var(--other);font-weight:700;color:var(--sub)}
/* Some Risu themes force image height:auto, and tall portrait assets then overrun
   the fixed avatar box and cover the contact's name. Take the image out of layout
   and pin it to the avatar bounds, keeping the online dot above the photo. */
.av>img{position:absolute;inset:0;display:block;width:100%!important;height:100%!important;min-width:0;min-height:0;max-width:100%;max-height:100%;border-radius:50%;object-fit:cover!important;object-position:center}
.av>.dot{z-index:1}
.av .dot{position:absolute;right:0;bottom:0;width:27%;height:27%;min-width:10px;min-height:10px;border-radius:50%;background:var(--green);border:2px solid var(--bg)}
.stack{position:relative;flex:none;display:inline-block}.stack .av{position:absolute}.stack .av:first-child{right:0;top:0}.stack .av:last-child{left:0;bottom:0;box-shadow:0 0 0 2px var(--bg)}
.active{display:flex;gap:4px;overflow-x:auto;padding:4px 8px 8px;scrollbar-width:none}.active::-webkit-scrollbar{display:none}
.act{flex:none;width:72px;padding:6px 2px;border-radius:10px;display:flex;flex-direction:column;align-items:center;gap:5px;font-size:12px;color:var(--sub)}
.act .n{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rows{padding:0 6px 8px}
.row{display:flex;align-items:center;gap:12px;width:100%;padding:8px;border-radius:10px;text-align:left}.row.flat{padding:6px 0}
button.row:hover,.rowmain:hover{background:var(--hover)}
.mid{flex:1;min-width:0;display:block;text-align:left}.rowmain{padding:4px 6px;border-radius:10px}.avbtn{flex:none;border-radius:50%}
.nm{display:block;font-size:15px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pv{display:flex;gap:4px;font-size:13px;color:var(--sub)}.tx{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tm{flex:none}
.row.un .nm{font-weight:700}.row.un .tx{color:var(--text);font-weight:600}
.un-dot{flex:none;width:12px;height:12px;border-radius:50%;background:var(--blue)}
.acct-bar{flex:none;display:flex;align-items:center;gap:8px;margin:0 12px 8px;padding:8px 10px;border-radius:10px;background:color-mix(in srgb,var(--blue) 14%,var(--bg));color:var(--text);font-size:13px}.acct-bar .mid{flex:1;min-width:0}.acct-bar .ico{color:var(--blue)}
.me-btn.acct .av{box-shadow:0 0 0 2px var(--blue)}
.badge{flex:none;min-width:20px;height:20px;padding:0 6px;box-sizing:border-box;border-radius:10px;background:var(--red);color:#fff;font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
.acct-on{flex:none;color:var(--blue)}.row.on{background:var(--bg2)}
.msg-note{font-size:11px;color:var(--sub);margin:1px 4px 0}
.polish{flex:none;margin:0 10px 6px;padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--blue) 14%,var(--bg));display:flex;flex-direction:column;gap:6px;font-size:12px}.polish b{color:var(--text)}.polish .sub{margin:0}
.sheet-scrim{position:absolute;inset:0;z-index:40;background:var(--scrim);display:flex;align-items:flex-end}.send-sheet{width:100%;max-height:92%;overflow:auto;box-sizing:border-box;background:var(--bg);border-radius:16px 16px 0 0;padding:8px 16px 20px;display:flex;flex-direction:column;gap:10px}.send-sheet .acts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.send-sheet textarea{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--bg);color:var(--text);font:inherit;resize:vertical}.sect.flush{padding:8px 0 0}.act2.on{background:var(--bg2)}.pill.grow{flex:1}
.send-preview{display:flex;justify-content:center}.send-preview img{max-width:100%;max-height:220px;border-radius:12px}
.sect{padding:10px 14px 4px;font-size:15px;font-weight:700;display:flex;justify-content:space-between;align-items:baseline}.sect small{font-size:13px;font-weight:400;color:var(--sub)}
.notice{margin:2px 12px 8px;padding:8px 10px;border-radius:10px;background:var(--bg2);color:var(--sub);font-size:13px}.notice[hidden]{display:none}
.actions{display:flex;flex-wrap:wrap;gap:6px;padding:2px 12px 6px}
.pill{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:7px 12px;border-radius:8px;background:var(--bg2);font-size:13px;font-weight:600}.pill.primary{background:var(--blue);color:#fff}
.tabs{flex:none;display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}
.tab{display:flex;flex-direction:column;align-items:center;gap:1px;padding:7px 0 6px;font-size:11px;color:var(--sub)}.tab[aria-selected="true"]{color:var(--blue);font-weight:600}
.who-btn{flex:1;min-width:0;display:flex;align-items:center;gap:8px;text-align:left;border-radius:8px;padding:2px 4px}
.who-btn .nm{font-weight:600}.st{display:block;font-size:12px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.thread{padding:12px 10px 8px}
.hello{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;padding:14px 16px 22px}
.hello .nm{font-size:17px;font-weight:700;margin-top:6px}.hello .bio{font-size:13px;max-width:30ch}.hello .meta{color:var(--sub);font-size:13px}.hello .pill{margin-top:8px}
.time{text-align:center;color:var(--sub);font-size:12px;padding:12px 0 8px}
.msg{display:flex;align-items:flex-end;gap:8px;margin-top:2px}.msg.me{justify-content:flex-end}.slot{flex:none;width:28px;min-height:1px}
.col{display:flex;flex-direction:column;align-items:flex-start;max-width:72%;min-width:0}.me .col{align-items:flex-end}
.sender{font-size:12px;color:var(--sub);margin:8px 0 2px 12px}
.b{padding:8px 12px;background:var(--other);border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere}.me .b{background:var(--blue);color:#fff}.failed .b{opacity:.55}.b.big{background:none!important;padding:0 2px;font-size:36px;line-height:1.1}
.msg.g-first:not(.me) .b{border-bottom-left-radius:4px}.msg.g-mid:not(.me) .b{border-top-left-radius:4px;border-bottom-left-radius:4px}.msg.g-last:not(.me) .b{border-top-left-radius:4px}
.msg.g-first.me .b{border-bottom-right-radius:4px}.msg.g-mid.me .b{border-top-right-radius:4px;border-bottom-right-radius:4px}.msg.g-last.me .b{border-top-right-radius:4px}
.typing{display:flex;gap:4px;padding:11px 12px}.typing i{width:7px;height:7px;border-radius:50%;background:var(--sub);animation:t 1.1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}
.typing.story{align-items:center;gap:8px;color:var(--sub);font-size:13px}
.spin.small{width:14px;height:14px;border-width:2px;flex:none}
@keyframes t{0%,60%,100%{opacity:.35}30%{opacity:1}}@media (prefers-reduced-motion:reduce){.typing i{animation:none}}
.error{margin:10px 0;padding:10px;border-radius:10px;background:var(--bg2);color:var(--red);font-size:13px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.composer{flex:none;display:flex;align-items:flex-end;gap:4px;padding:6px 6px calc(8px + env(safe-area-inset-bottom,0px)) 10px}
.composer textarea{flex:1;min-width:0;height:40px;max-height:120px;resize:none;border:0;outline:0;border-radius:20px;background:var(--bg2);padding:9px 14px;font-size:16px;line-height:22px}.composer textarea::placeholder{color:var(--sub)}
.cover{height:128px;overflow:hidden;background:var(--bg2)}.cover img{display:block;width:100%;height:100%;object-fit:cover;filter:blur(16px) saturate(1.2);transform:scale(1.25)}
.prof{padding:0 16px 8px;display:flex;flex-direction:column;align-items:center;text-align:center;margin-top:-52px;position:relative}
.ring{border-radius:50%;box-shadow:0 0 0 4px var(--bg);display:inline-flex}.prof h2{margin:10px 0 0;font-size:20px;font-weight:700}.prof .st{font-size:13px}.prof .bio{margin-top:8px;font-size:14px;max-width:32ch}
.acts{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:8px 12px 12px}.act2{display:flex;flex-direction:column;align-items:center;gap:5px;font-size:12px;padding:6px 0;border-radius:10px}
.scope{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:var(--bg2);color:var(--sub);font-size:11px;font-weight:500;line-height:1.5;vertical-align:1px;white-space:nowrap}.scope-all{background:rgba(0,132,255,.12);color:var(--blue)}.scope-bot{background:rgba(49,162,76,.14);color:var(--green)}
.inline-edit{display:flex;gap:6px;margin-top:8px;justify-content:center;width:100%}.inline-edit input{flex:1;min-width:0;max-width:260px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg)}.me-btn{border-radius:50%}
.seg{display:flex;margin:10px 16px 4px;background:var(--bg2);border-radius:10px;padding:3px}.seg button{flex:1;padding:7px 0;border-radius:8px;font-weight:600;color:var(--sub)}.seg button[aria-pressed="true"]{background:var(--bg);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.15)}.seg-note{margin:0 16px 6px;font-size:12px;color:var(--sub)}
.follow{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--sub);cursor:pointer;position:relative}.follow input{position:absolute;opacity:0;width:1px;height:1px;margin:0}.follow i{position:relative;width:34px;height:20px;border-radius:999px;background:var(--line);flex:none}.follow i::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}.follow input:checked+i{background:var(--blue)}.follow input:checked+i::after{left:16px}.follow input:focus-visible+i{outline:2px solid var(--blue);outline-offset:2px}
.from-bot{font-size:12px;color:var(--blue);margin:-4px 0 6px}.from-bot.own{color:var(--sub)}.followed{opacity:.5}
.follow-row{margin:6px 16px 10px;padding:10px 12px;background:var(--bg2);border-radius:12px}.follow-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.follow-head b{flex:1;font-size:14px;min-width:140px}.follow-row .sub{margin-top:4px}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{padding:5px 10px;border-radius:999px;font-size:13px;font-weight:600;background:var(--bg2);color:var(--sub)}.chip.on{background:var(--blue);color:#fff}.scope-warn{background:rgba(228,30,63,.12);color:var(--red)}
.card{border-top:8px solid var(--bg2);padding:10px 16px 12px}.card.first{border-top:0}.card h3{margin:0 0 8px;font-size:15px;font-weight:700;display:flex;justify-content:space-between;align-items:baseline}.card h3 small{font-weight:400;font-size:12px;color:var(--sub)}
.fact{display:flex;gap:10px;padding:5px 0;font-size:14px;align-items:flex-start}.fact .ico{color:var(--sub);margin-top:1px}.fact span:last-child{min-width:0}
.photos{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;border-radius:10px;overflow:hidden}.photos button{aspect-ratio:1;display:block;position:relative;background:var(--bg2);overflow:hidden}.photos img{display:block;width:100%;height:100%;object-fit:contain}.now{position:absolute;left:4px;bottom:4px;padding:1px 6px;border-radius:9px;background:var(--blue);color:#fff;font-size:11px}
.asset-gallery{min-width:0}.asset-gallery>input{width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg2)}.gallery-tabs{display:flex;gap:6px;overflow:auto;max-height:130px;flex-wrap:wrap;margin:10px 0}.gallery-tabs .pill{max-width:100%;white-space:normal;overflow-wrap:anywhere}.asset-grid{margin:8px 0}.pager{display:flex;align-items:center;justify-content:center;gap:12px;margin:8px 0}.picker-sheet{position:absolute;inset:0;z-index:50;background:var(--bg);display:flex;flex-direction:column}.picker-body{flex:1;overflow:auto;padding:12px 16px 16px}.asset-grid button[aria-pressed="true"]{outline:3px solid var(--blue);outline-offset:-3px}.asset-grid img{position:absolute;inset:0;width:100%!important;height:100%!important;object-fit:contain}.asset-grid .now{z-index:1}
.set{display:flex;align-items:center;gap:12px;width:100%;min-height:44px;padding:8px 0;text-align:left;font-size:15px;cursor:pointer}.set small{display:block;font-size:13px;color:var(--sub)}.set.danger{color:var(--red)}.set.menu{min-height:56px}.mem{padding:8px 0;border-top:1px solid var(--line)}.mem small{display:block;margin-top:2px}.mem .actions{margin-top:4px}.mem-h{margin:14px 0 4px;font-size:13px;font-weight:600;color:var(--sub)}.set.menu>.ico{color:var(--sub)}
.sw{flex:none;position:relative;width:42px;height:26px}.sw input{position:absolute;inset:0;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}.sw i{display:block;width:100%;height:100%;border-radius:13px;background:var(--line)}.sw i::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}.sw input:checked+i{background:var(--blue)}.sw input:checked+i::after{transform:translateX(16px)}.sw input:focus-visible+i{outline:2px solid var(--blue);outline-offset:2px}
.sub{color:var(--sub);font-size:13px}
.jobbar{flex:none;display:flex;align-items:center;gap:8px;margin:6px 12px;padding:6px 6px 6px 12px;border-radius:10px;background:var(--bg2);color:var(--sub);font-size:13px}
.jobbar .mid{display:flex;flex-direction:column;gap:5px;min-width:0}
.jobtext{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jobfail{color:var(--red)}
.jobprog{display:block;height:4px;border-radius:2px;background:var(--line);overflow:hidden}
.jobprog i{display:block;height:100%;background:var(--blue);transition:width .25s}.row.done{opacity:.6}.actions.flush{padding:8px 0 0}.notice.flush{margin:0 0 8px}.notice .pill{margin-left:8px}
.kv{display:flex;gap:10px;padding:4px 0;font-size:14px}.kv .k{flex:none;width:76px;color:var(--sub);font-size:13px}.kv span:last-child{min-width:0;overflow-wrap:anywhere}
.pair{display:grid;gap:6px}.pair input,.term input,.model select,.model input{width:100%;margin-top:6px;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);font-size:16px}.model{padding:6px 0}.model input[hidden]{display:none}
.term{display:flex;gap:4px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}.term .from{font-size:13px;color:var(--sub)}.search.flush{margin:0 0 8px}.top-gap{margin-top:8px}
.field textarea{width:100%;margin-top:6px;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);font-size:16px;resize:vertical}
.card>input,.me-card input,.field input,.field select{width:100%;margin-top:6px;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);font-size:16px}
.me-card{display:flex;align-items:flex-start;gap:12px;padding:4px 0}
.field{display:block;padding:6px 16px}.field.flat{padding:6px 0}.label{font-size:13px;color:var(--sub)}.center{display:flex;justify-content:center;padding:16px}
.pick{cursor:pointer;position:relative}.pick input{position:absolute;opacity:0;width:0;height:0}.check{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid var(--sub)}.pick input:checked+.check{background:var(--blue);border-color:var(--blue)}.pick input:focus-visible+.check{outline:2px solid var(--blue);outline-offset:2px}
.tabs.three{grid-template-columns:1fr 1fr 1fr}
.ph{display:block;position:relative;width:min(220px,62vw);border-radius:16px;overflow:hidden;background:var(--bg2);margin:2px 0}.ph img{position:absolute;inset:0;width:100%!important;height:100%!important;object-fit:cover}
.ph-wait{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:12px;color:var(--sub);font-size:13px;text-align:center}.ph-wait.small{aspect-ratio:auto}.ph-wait small{font-size:12px}.ph-note{position:absolute;inset:0;display:grid;place-items:center;padding:8px;color:var(--sub);font-size:12px}
.spin{width:22px;height:22px;border-radius:50%;border:3px solid var(--line);border-top-color:var(--blue);animation:sp 0.9s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spin{animation:none}}
.chips{display:flex;gap:6px;overflow-x:auto;padding:8px 12px 2px;scrollbar-width:none}.chips::-webkit-scrollbar{display:none}.chips .pill{flex:none}
.gal{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;padding:0 0 8px}.gal.small{border-radius:10px;overflow:hidden;padding:0}.gitem{position:relative;aspect-ratio:1;overflow:hidden;background:var(--bg2)}.gitem img{position:absolute;inset:0;width:100%!important;height:100%!important;object-fit:cover}
.viewer{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;background:#000;color:#fff}
.vtop{flex:none;display:flex;align-items:center;gap:6px;padding:8px 10px}.vtop .st{color:#bbb}.plain.light{color:#fff}
.vbody{flex:1;min-height:0;position:relative;display:flex;align-items:center;justify-content:center}.vbody img{max-width:100%;max-height:100%;object-fit:contain}
.vnav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,.45);color:#fff;display:grid;place-items:center}.vnav.l{left:8px}.vnav.r{right:8px}
.msg{cursor:default}.msg.picked .b,.msg.picked .ph{outline:2px solid var(--blue);outline-offset:1px}.tick{flex:none;align-self:center;width:20px;height:20px;border-radius:50%;border:2px solid var(--sub);margin-right:4px}.tick[aria-checked="true"]{background:var(--blue);border-color:var(--blue)}
.msg-acts{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px 36px}.msg-acts.me{justify-content:flex-end;margin-left:0}.pill.danger{color:var(--red)}
.room-menu{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px 10px;border-bottom:1px solid var(--line);background:var(--bg);flex:none}
.r18-toggle{font-size:11px;white-space:nowrap;padding:7px 8px;flex:none}
.selbar{flex:none;display:flex;align-items:center;gap:10px;padding:8px 10px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--line)}
.debug-ok{color:var(--green);font-size:14px;margin-top:6px}.debug-bad{color:var(--red);font-size:14px;margin-top:6px}.debug-reasons{margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--sub)}.debug-raw{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:var(--bg2);padding:8px;border-radius:8px;max-height:320px;overflow:auto}
.vcap{flex:none;padding:8px 16px;font-size:14px;color:#ddd;white-space:pre-wrap}
.vdetails{flex:none;padding:8px 16px;font-size:12px;max-height:40%;overflow:auto;background:#171717}.vdetails summary{cursor:pointer;padding:6px 0}.vdetails pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;color:#ddd}
.prompt-field{display:block;margin:10px 0}.prompt-field textarea{display:block;width:100%;margin-top:4px;padding:8px;box-sizing:border-box;background:#252525;color:#fff;border:1px solid #777;border-radius:6px;resize:vertical}.vdetails .actions{flex-wrap:wrap}
.viewer .pill{background:#333;color:#fff;border:1px solid #888}.viewer .pill.primary{background:var(--blue);color:#fff;border-color:var(--blue)}.viewer .pill:disabled{opacity:.6}
.vacts{flex:none;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;padding:6px 6px calc(8px + env(safe-area-inset-bottom,0px))}.vbtn{display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 0;color:#fff;font-size:12px}
`;

//#endregion
//#region src/ui/open.js
	function mountUi() {
		if (document.getElementById("win")) return;
		document.head.append(h("style", {}, CSS));
		applyTheme();
		document.body.append(h("div", {
			class: "scrim",
			"data-t": "scrim",
			onclick: closeWindow
		}), h("div", {
			class: "win",
			id: "win",
			role: "dialog",
			"aria-label": "Interlude"
		}));
		document.addEventListener("keydown", (e) => {
			if (e.key !== "Escape" || !view.open) return;
			if (view.viewer) closeViewer();
			else closeWindow();
		});
	}
	async function loadMe(ctx) {
		let persona = null;
		try {
			const db = await risuai.getDatabase(["personas", "selectedPersona"]);
			const list = db?.personas || [];
			persona = list.find((p) => p.id && p.id === ctx.chat.bindedPersona) || list[db?.selectedPersona ?? 0] || null;
		} catch (e) {
			console.log("[interlude] persona failed: " + e.message);
			void systemFailure("load", e, "persona failed");
		}
		const name = persona?.name || await parseCbs("{{user}}") || "나";
		const assets = (persona?.embeddedModule?.assets || []).filter(isImageAsset).map((a) => ({
			name: String(a[0]),
			path: a[1]
		}));
		if (persona?.icon) assets.unshift({
			name: "페르소나 프로필 이미지",
			path: persona.icon
		});
		view.meAssets = assets.filter((a, i) => assets.findIndex((b) => b.path === a.path) === i);
		view.me = {
			name,
			image: persona?.icon || ICON_URI,
			defaultImage: persona?.icon || ICON_URI,
			personaKey: persona?.id || name + ":" + (persona?.icon || ""),
			fromPersona: !!persona
		};
	}
	let openingMessenger = null;
	function openMessenger() {
		if (openingMessenger) return openingMessenger;
		openingMessenger = loadMessenger().finally(() => {
			openingMessenger = null;
		});
		return openingMessenger;
	}
	async function loadMessengerRaw() {
		view.cancelCrop?.();
		mountUi();
		view.open = true;
		const started = performance.now();
		const timing = globalThis.__interludeOpenTiming = {};
		const mark = (stage) => {
			timing[stage] = Math.round(performance.now() - started);
		};
		const loading = h("div", {
			class: "meta",
			"data-t": "opening",
			role: "status"
		}, "대화 기록을 불러오는 중…");
		document.getElementById("win").replaceChildren(h("div", { class: "top line-b" }, h("img", {
			class: "logo",
			src: ICON_URI,
			alt: ""
		}), h("h1", { class: "small" }, "Interlude"), closeBtn()), h("div", { class: "scroll" }, h("div", { class: "hello" }, loading)));
		await risuai.showContainer("fullscreen");
		mark("shown");
		let ctx = null;
		let contextError = "";
		try {
			ctx = await getContext();
		} catch (e) {
			contextError = e.message;
			console.log("[interlude] open failed: " + e.message);
		}
		if (!view.open) return { status: "cancelled" };
		if (!ctx) {
			view.key = "";
			document.getElementById("win").replaceChildren(h("div", { class: "top line-b" }, h("img", {
				class: "logo",
				src: ICON_URI,
				alt: ""
			}), h("h1", { class: "small" }, "Interlude"), closeBtn()), h("div", { class: "scroll" }, h("div", { class: "hello" }, h("div", {
				class: "meta",
				"data-t": "no-chat"
			}, "채팅방을 먼저 열어 주세요. 메신저는 챗마다 따로 켜고 끕니다."))));
			await risuai.showContainer("fullscreen");
			return {
				status: contextError ? "failed" : "skipped",
				error: contextError
			};
		}
		mark("context");
		view.ctx = ctx;
		if (view.key !== ctx.key) {
			Object.assign(view, {
				key: ctx.key,
				screen: "list",
				tab: "chats",
				q: "",
				notice: "",
				draft: "",
				assets: null,
				lastScreen: "",
				importDraft: null,
				importError: ""
			});
		}
		view.storyText = appearanceText(recentWindow(ctx.chat, STORY_CHARS).text);
		const [slot, , , state] = await Promise.all([
			risuai.getArgument("model_slot"),
			loadTerms(ctx.char.chaId),
			loadMe(ctx),
			loadState(ctx.key),
			loadImageCfg().catch((e) => systemFailure("load", e, "image-settings")),
			loadUiCfg().catch((e) => systemFailure("load", e, "ui-settings"))
		]);
		view.modelSlot = String(slot || "aux");
		applyMyPhoto(state);
		mark("state");
		loading.textContent = "저장된 인물 분석을 확인하는 중…";
		await hydrateSharedAnalysis(ctx, state);
		mark("analysis");
		if (state.enabled && state.contacts.some((c) => !c.manualImage)) {
			loading.textContent = "프로필 사진을 확인하는 중…";
			const assets = view.assets || await gatherAssets(ctx);
			if (repairAutoImages(state, assets)) await saveState(ctx.key);
		}
		if (state.enabled && !state.avatarsChecked && state.contacts.some((c) => c.profileShots?.length)) void upgradeDrawnAvatars(ctx.key, state).catch((e) => console.log("[interlude] profile upgrade failed: " + e.message));
		if (accountOf() !== "me") {
			view.account = "me";
			Object.assign(view, {
				polish: null,
				polishError: "",
				draft: ""
			});
			const room = state.rooms.find((r) => r.id === view.roomId);
			if (view.screen === "switch" || view.screen === "profile" || view.screen === "room" && !(room && inAccount(room, "me"))) Object.assign(view, {
				screen: "list",
				tab: "chats",
				roomId: ""
			});
		}
		if (view.screen === "room") {
			const room = state.rooms.find((r) => r.id === view.roomId);
			if (room?.unread) {
				room.unread = 0;
				await saveState(ctx.key);
			}
			view.roomJustOpened = true;
		}
		mark("assets");
		render();
		mark("ready");
		syncFab();
		const grown = (ctx.chat.message || []).length - (state.scannedMessages ?? 0);
		if (state.enabled && grown >= AUTO_RESCAN_AFTER && state.candidates) {
			state.scannedMessages = (ctx.chat.message || []).length;
			const has = existingPersonKeys(state), removed = new Set(state.removedNames || []);
			const fresh = dedupeCandidates(state.candidates).filter((c) => inStory(c) && !has.has(personKey(c)) && !removed.has(normalize(c.name)));
			if (fresh.length) {
				view.notice = `최근 대화에서 후보 ${fresh.length}명의 이름이 확인됐어요. 추가할 인물은 직접 골라 주세요.`;
				view.noticePick = true;
				render();
			}
			await saveState(ctx.key);
		}
	}
	const loadMessenger = systemInstrument("open", loadMessengerRaw, (r) => r);

//#endregion
//#region src/ui/fab.js
	let fabSignature = "";
	let fabPlace = "";
	let fabSyncing = false;
	let fabPending = false;
	const FAB_SHAPES = ICON_SVG.replace(/^<svg[^>]*>|<\/svg>$/g, "").replace(/id="c"/, "id=\"interlude-fab-c\"").replace(/url\(#c\)/g, "url(#interlude-fab-c)");
	function fabIcon(count, size = 20) {
		const label = count > 9 ? "9+" : String(count);
		const text = (x, size) => `<text x="${x}" y="${5.5 + size * .36}" text-anchor="middle" font-size="${size}" font-weight="700" font-family="sans-serif" fill="#ffffff">${label}</text>`;
		const dot = !count ? "" : count > 9 ? `<rect x="10.5" y="0.5" width="13" height="10" rx="5" fill="#FF3B30" stroke="#ffffff" stroke-width="1"/>${text(17, 7)}` : `<circle cx="18.5" cy="5.5" r="5" fill="#FF3B30" stroke="#ffffff" stroke-width="1"/>${text(18.5, 8)}`;
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" role="img" aria-label="Interlude${count ? ` 안 읽은 메시지 ${count}개` : ""}"><svg x="0" y="0" width="24" height="24" viewBox="0 0 64 64">${FAB_SHAPES}</svg>${dot}</svg>`;
	}
	async function syncFab() {
		if (fabSyncing) {
			fabPending = true;
			return;
		}
		fabSyncing = true;
		try {
			let charIndex = -1, chatIndex = -1;
			try {
				charIndex = await risuai.getCurrentCharacterIndex();
				if (charIndex >= 0) chatIndex = await risuai.getCurrentChatIndex();
			} catch {
				charIndex = -1;
			}
			const place = `${charIndex}:${chatIndex}`;
			const unreadOf = (state) => accountUnread(state, "me");
			let signature = "";
			if (charIndex >= 0 && chatIndex >= 0) {
				const current = await currentPlace();
				if (current) {
					const state = await loadState(current.key);
					signature = state.enabled ? `on:${unreadOf(state)}` : "off";
				}
			}
			if (signature === fabSignature) {
				fabPlace = place;
				return;
			}
			const count = signature.startsWith("on:") ? Number(signature.slice(3)) : 0;
			if (await floatingButton(openMessenger)) {
				if (signature) await showFloating(fabIcon(count, 48));
				else await hideFloating();
			} else if (!signature) {
				await risuai.unregisterUIPart("interlude-fab");
			} else {
				await risuai.registerButton({
					name: "Interlude",
					icon: fabIcon(count),
					iconType: "html",
					location: "action",
					id: "interlude-fab"
				}, openMessenger);
			}
			fabSignature = signature;
			fabPlace = place;
		} catch (e) {
			fabPlace = "";
			console.log("[interlude] button failed: " + e.message);
			void systemFailure("open", e, "button failed");
		} finally {
			fabSyncing = false;
			if (fabPending) {
				fabPending = false;
				syncFab();
			}
		}
	}
	setInterval(async () => {
		try {
			const charIndex = await risuai.getCurrentCharacterIndex();
			const chatIndex = charIndex >= 0 ? await risuai.getCurrentChatIndex() : -1;
			if (`${charIndex}:${chatIndex}` !== fabPlace) syncFab();
		} catch {
			if (fabPlace !== "-1:-1") syncFab();
		}
	}, 1500);

//#endregion
//#region src/ui/screens/accounts.js
	function switchAccount(id) {
		view.account = id;
		Object.assign(view, {
			q: "",
			roomId: "",
			selecting: null,
			msgMenu: "",
			draft: "",
			polish: null
		});
		go("list", {
			tab: "chats",
			notice: ""
		});
	}
	const accountUnread = (state, id) => state.rooms.filter((r) => id === "me" ? !r.as : r.as === id).reduce((n, r) => n + (r.unread || 0), 0);
	function switchScreen(state) {
		const acct = accountOf();
		const row = (id, person, sub) => {
			const unread = accountUnread(state, id), on = acct === id;
			return h("button", {
				class: "row" + (on ? " on" : ""),
				"data-t": "account",
				"data-name": person?.name || "",
				"aria-pressed": String(on),
				onclick: () => switchAccount(id)
			}, avatar(person, 48), h("span", { class: "mid" }, h("span", { class: "nm" }, id === "me" ? `${person?.name || "나"} (사용자)` : person?.name || "?"), h("span", { class: "pv" }, h("span", { class: "tx" }, sub))), on ? h("span", {
				class: "acct-on",
				"data-t": "account-current"
			}, icon("check", 22)) : unread ? h("span", {
				class: "badge",
				"aria-label": `읽지 않은 메시지 ${unread}개`,
				"data-t": "account-unread"
			}, unread > 9 ? "9+" : String(unread)) : null);
		};
		const summary = (id) => {
			const rooms = roomsOf(state, id).filter((r) => r.msgs.length);
			if (!rooms.length) return id === "me" ? "내 계정" : "아직 이 계정으로 쓴 적 없음";
			const last = Math.max(...rooms.map((r) => r.msgs.at(-1).t));
			return `방 ${rooms.length}개 · 마지막 대화 ${ago(last)}`;
		};
		const people = state.contacts.filter((c) => isVisibleContact(state, c));
		return [h("div", { class: "top line-b" }, backBtn(() => go(view.switchFrom || "list")), h("h1", { class: "small" }, "계정 전환"), closeBtn()), h("div", {
			class: "scroll",
			id: "scroll"
		}, h("div", { class: "sect" }, "내 계정", h("small", {}, SCOPES.chat)), h("div", { class: "rows" }, row("me", view.me, acct === "me" ? "지금 쓰는 계정" : summary("me"))), h("div", { class: "sect" }, "캐릭터 계정", h("small", {}, `${people.length}명`)), people.length ? h("div", { class: "rows" }, people.map((c) => row(c.id, c, acct === c.id ? "지금 쓰는 계정" : summary(c.id)))) : h("div", { class: "hello" }, h("div", { class: "meta" }, "아직 인물이 없어요.")), h("div", { class: "notice" }, "빨간 숫자는 그 계정에만 있는 방의 안 읽은 메시지예요. 떠 있는 버튼의 빨간 점에는 내 계정 방만 세요. 메신저를 다시 열면 내 계정으로 시작해요."))];
	}
	const switchButton = (from) => h("button", {
		class: "act2",
		"data-t": "account-switch",
		onclick: () => go("switch", { switchFrom: from })
	}, h("span", { class: "round primary" }, icon("swap")), "계정 전환");
	function openRoom(room) {
		room.unread = 0;
		saveState(view.key);
		syncFab();
		go("room", {
			roomId: room.id,
			roomJustOpened: true,
			roomMenu: false,
			msgMenu: "",
			selecting: null,
			r18Error: ""
		});
	}

//#endregion
//#region src/ui/screens/auto-memory.js
	function autoMemoryIntroPanel(state, choose = null, selected = null) {
		if (!state.enabled || !autoMemoryRecord || autoMemoryRecord.answered || view.chatDelete) return null;
		const key = view.key;
		return h("div", {
			class: "crop-overlay",
			role: "dialog",
			"aria-modal": "true",
			"aria-label": "메모리 자동 정리 안내",
			"data-t": "auto-memory-intro"
		}, h("section", { class: "card dialog-card" }, h("h3", {}, "메모리를 켜면 대화도 자동으로 기억해요"), h("p", { class: "sub" }, "앞으로 메모리를 켜면 대화 자동 정리도 함께 켜집니다. 지금까지 쓰던 채팅에도 적용할 범위를 골라 주세요. 세부 설정에서 자동 정리만 따로 끌 수 있어요."), h("p", { class: "sub" }, `새 메시지가 ${MEMORY_EVERY}개 쌓이면 답장 뒤에 모델을 한 번 더 불러 기억을 정리해요. 지금 선택하는 것만으로는 모델을 부르지 않아요.`), view.autoMemoryError ? h("div", {
			class: "notice flush",
			role: "alert",
			"data-t": "auto-memory-error"
		}, view.autoMemoryError) : null, h("div", { class: "actions flush" }, ...[
			["all", "전체 챗에 반영"],
			["bot", "이 봇에 반영"],
			["none", "반영 안 함"]
		].map(([scope, label]) => h("button", {
			class: "pill" + (selected === scope ? " primary" : ""),
			"data-t": "auto-memory-" + scope,
			"aria-pressed": selected === scope ? "true" : "false",
			disabled: !!view.autoMemorySaving,
			onclick: () => choose ? choose(scope) : applyAutoMemoryChoice(key, scope)
		}, label)))));
	}
	let pendingRecovery = [];
	async function recoverChoice(undos) {
		const failed = [];
		for (const undo of [...undos].reverse()) {
			try {
				await undo();
			} catch {
				failed.unshift(undo);
			}
		}
		pendingRecovery = failed;
		if (failed.length) throw new Error("이전 설정을 모두 복구하지 못했어요. 다시 누르면 복구를 재시도해요.");
	}
	async function restoreStored(key, raw) {
		if (raw === undefined || raw === null) await risuai.pluginStorage.removeItem(key);
		else await risuai.pluginStorage.setItem(key, raw);
	}
	async function applyAutoMemoryChoice(key, scope) {
		if (view.autoMemorySaving) return false;
		view.autoMemorySaving = true;
		view.autoMemoryError = "";
		render();
		const undos = [];
		try {
			if (pendingRecovery.length) await recoverChoice(pendingRecovery);
			const record = await loadAutoMemoryRecord();
			if (!record) throw new Error("메모리 안내 상태를 읽지 못했어요. 다시 눌러 주세요.");
			if (scope !== "none") {
				const botId = botIdOf(key), keys = await risuai.pluginStorage.keys() || [];
				const prefix = scope === "all" ? STORE_PREFIX : STORE_PREFIX + botId + ":";
				const chatKeys = [...new Set([
					key,
					...keys,
					...states.keys()
				].filter((k) => k.startsWith(prefix)))];
				const botIds = new Set([botId, ...chatKeys.map(botIdOf)]);
				if (scope === "all") {
					for (const k of keys) if (k.startsWith(BOT_PREFIX)) botIds.add(k.slice(BOT_PREFIX.length));
					for (const id of botCfgs.keys()) botIds.add(id);
				}
				for (const k of chatKeys) {
					const loaded = states.get(k), raw = loaded ? undefined : await risuai.pluginStorage.getItem(k);
					const state = loaded || (typeof raw === "string" ? JSON.parse(raw) : raw);
					if (!state || typeof state !== "object") continue;
					const previous = {
						newMemory: state.newMemory,
						memoryOn: state.memoryOn
					};
					const hadMemory = Object.hasOwn(state, "newMemory"), hadAuto = Object.hasOwn(state, "memoryOn");
					undos.push(async () => {
						if (loaded) {
							if (hadMemory) state.newMemory = previous.newMemory;
							else delete state.newMemory;
							if (hadAuto) state.memoryOn = previous.memoryOn;
							else delete state.memoryOn;
							await saveState(k);
						} else await restoreStored(k, raw);
					});
					state.newMemory = true;
					state.memoryOn = true;
					if (loaded) await saveState(k);
					else await risuai.pluginStorage.setItem(k, JSON.stringify(state));
				}
				for (const id of botIds) {
					const botKey = BOT_PREFIX + id, raw = await risuai.pluginStorage.getItem(botKey), previous = botCfgs.get(id);
					const cfg = {
						...await loadBotCfg(id),
						newMemory: true,
						memoryOn: true
					};
					undos.push(async () => {
						if (previous) botCfgs.set(id, previous);
						else botCfgs.delete(id);
						await restoreStored(botKey, raw);
					});
					await risuai.pluginStorage.setItem(BOT_PREFIX + id, JSON.stringify({
						schema: 1,
						...cfg
					}));
					botCfgs.set(id, cfg);
				}
			}
			await saveAutoMemoryRecord({
				...record,
				answered: true,
				choice: scope
			});
			return true;
		} catch (e) {
			if (undos.length) {
				try {
					await recoverChoice(undos);
				} catch (recoveryError) {
					view.autoMemoryError = recoveryError.message;
					return false;
				}
			}
			view.autoMemoryError = "저장하지 못했어요. 다시 눌러 주세요. " + e.message;
			return false;
		} finally {
			view.autoMemorySaving = false;
			render();
		}
	}

//#endregion
//#region src/ui/screens/update-settings.js
	function section(panel) {
		const contents = [...panel.firstElementChild.childNodes];
		panel.className = "card";
		panel.style.cssText = "padding:14px 0;margin:12px 0;border-radius:0";
		for (const name of [
			"role",
			"aria-modal",
			"aria-label"
		]) panel.removeAttribute(name);
		panel.replaceChildren(...contents);
		return panel;
	}
	function updateSettingsPanel(state) {
		if (!state.enabled || view.chatDelete) return null;
		let draft = view.updateSettings;
		if (draft?.key !== view.key) {
			draft = view.updateSettings = {
				key: view.key,
				auto: null,
				memory: null,
				saving: false,
				error: ""
			};
			view.budgetIntro = null;
		}
		const select = (field) => (value) => {
			draft[field] = value;
			draft.error = "";
			render();
		};
		const auto = autoMemoryIntroPanel(state, select("auto"), draft.auto);
		const memory = auto ? null : memoryIntroPanel(state, select("memory"), draft.memory);
		const budget = budgetIntroPanel(state, true);
		if (!auto && !memory && !budget) return null;
		const incomplete = auto && draft.auto === null || memory && draft.memory === null;
		const parts = {
			auto: !!auto,
			memory: !!memory,
			budget: budget ? view.budgetIntro : null
		};
		return h("div", {
			class: "crop-overlay",
			role: "dialog",
			"aria-modal": "true",
			"aria-label": "업데이트 후 설정",
			"data-t": "update-settings"
		}, h("section", { class: "card dialog-card" }, h("h3", {}, "업데이트 후 설정"), h("p", { class: "sub" }, "아직 선택하지 않은 설정만 모았어요. 항목별 적용 범위를 확인하고 한 번에 저장해 주세요."), h("fieldset", {
			disabled: draft.saving,
			style: "border:0;padding:0;margin:0;min-width:0"
		}, ...[
			auto,
			memory,
			budget
		].filter(Boolean).map(section)), draft.error ? h("div", {
			class: "notice flush",
			role: "alert",
			"data-t": "update-settings-error"
		}, draft.error) : null, h("div", {
			class: "actions flush",
			style: "justify-content:flex-end;position:sticky;bottom:0;background:var(--bg);padding-top:12px"
		}, h("button", {
			class: "pill primary",
			"data-t": "update-settings-save",
			disabled: draft.saving || !!incomplete,
			onclick: () => applyUpdateSettings(draft, parts)
		}, draft.saving ? "저장하는 중…" : "선택한 설정 저장"))));
	}
	async function applyUpdateSettings(draft, parts) {
		if (draft.saving) return;
		draft.saving = true;
		draft.error = "";
		render();
		try {
			if (parts.auto && !await applyAutoMemoryChoice(draft.key, draft.auto)) throw new Error(view.autoMemoryError);
			if (parts.memory && !await applyMemoryIntroChoice(draft.key, draft.memory)) throw new Error(view.memoryIntroError);
			if (parts.budget) {
				draft.budgetAttempt = true;
				if (!await applyBudgetChoice(draft.key, parts.budget)) throw new Error(parts.budget.error);
				draft.budgetAttempt = false;
			}
		} catch (e) {
			draft.error = (e.message || "설정을 저장하지 못했어요.") + " 저장되지 않은 항목을 확인하고 다시 눌러 주세요.";
		} finally {
			draft.saving = false;
			if (view.key === draft.key) render();
		}
	}

//#endregion
//#region src/ui/screens/group.js
	function groupScreen(state) {
		const picked = new Set();
		const nameInput = h("input", {
			type: "text",
			placeholder: "방 이름",
			"aria-label": "방 이름",
			"data-t": "group-name"
		});
		const notice = h("div", {
			class: "notice",
			hidden: true
		});
		const acct = accountOf();
		const pick = (person, id) => h("label", { class: "row pick" }, avatar(person, 40), h("span", { class: "mid" }, h("span", { class: "nm" }, id === "me" ? `${person?.name || "나"} (사용자)` : person.name)), h("input", {
			type: "checkbox",
			"data-t": "group-member",
			"data-name": person?.name || "",
			onchange: (e) => {
				if (e.target.checked) picked.add(id);
				else picked.delete(id);
			}
		}), h("span", { class: "check" }));
		const rows = [...acct === "me" ? [] : [pick(view.me, "me")], ...state.contacts.filter((c) => c.id !== acct && isVisibleContact(state, c)).map((contact) => pick(contact, contact.id))];
		const create = async () => {
			if (picked.size < 2) {
				notice.textContent = "참가자를 2명 이상 골라 주세요.";
				notice.hidden = false;
				return;
			}
			const others = [...picked].filter((id) => id !== "me");
			const room = acct === "me" ? {
				id: "group:" + newId(),
				type: "group",
				name: nameInput.value.trim() || "단톡방",
				members: [...picked],
				msgs: [],
				unread: 0
			} : picked.has("me") ? {
				id: "group:" + newId(),
				type: "group",
				name: nameInput.value.trim() || "단톡방",
				members: [acct, ...others],
				msgs: [],
				unread: 0
			} : {
				id: "group:" + newId(),
				type: "group",
				as: acct,
				name: nameInput.value.trim() || "단톡방",
				members: others,
				msgs: [],
				unread: 0
			};
			state.rooms.unshift(room);
			await saveState(view.key);
			openRoom(room);
		};
		return [h("div", { class: "top line-b" }, backBtn(() => go("list", { tab: "people" })), h("h1", { class: "small" }, "단톡방 만들기"), h("button", {
			class: "pill primary",
			"data-t": "group-create",
			onclick: create
		}, "만들기")), h("div", {
			class: "scroll",
			id: "scroll"
		}, h("label", { class: "field" }, nameInput), notice, h("div", { class: "rows" }, rows))];
	}

//#endregion
//#region src/chat/send-photo.js
	async function storePicture(bytes) {
		const full = await encodeImage(bytes, Infinity, .85);
		const thumb = await encodeImage(bytes, THUMB_WIDTH, .78);
		const id = newId();
		await risuai.pluginStorage.setItem(PHOTO_PREFIX + "full:" + id, full.url);
		await risuai.pluginStorage.setItem(PHOTO_PREFIX + "thumb:" + id, thumb.url);
		thumbUrls.set(id, thumb.url);
		return {
			id,
			w: full.w,
			h: full.h
		};
	}
	const urlBytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());
	async function copyPicture(source) {
		const full = await photoFull(source.photoId), thumb = await photoThumb(source.photoId);
		if (!full) throw new Error("고른 사진을 찾을 수 없어요.");
		const id = newId();
		await risuai.pluginStorage.setItem(PHOTO_PREFIX + "full:" + id, full);
		await risuai.pluginStorage.setItem(PHOTO_PREFIX + "thumb:" + id, thumb || full);
		thumbUrls.set(id, thumb || full);
		return {
			id,
			...Number.isFinite(source.w) && Number.isFinite(source.h) ? {
				w: source.w,
				h: source.h
			} : {}
		};
	}
	async function planSentPhoto(state, room, acct, desc) {
		const pcName = await parseCbs("{{user}}");
		const people = peopleOf(room).map((id) => id === "me" ? {
			id: "me",
			name: pcName,
			aliases: []
		} : state.contacts.find((c) => c.id === id)).filter(Boolean);
		const sender = people.find((p) => p.id === acct);
		const prompt = `${sender?.name || "보내는 사람"}이(가) 휴대폰 메신저로 보낼 사진을 NovelAI로 그리기 위한 태그를 만든다. [사진 설명]은 사용자가 쓴 설명이다.
- who: 사진에 보이는 사람의 이름 배열이다. 셀카이거나 보내는 사람이 나오면 ${sender?.name || "보내는 사람"}을(를) 넣는다. 다른 사람은 [사람]에 있는 이름만 쓴다. 사람이 나오지 않는 사진이면 빈 배열이다.
- tags: 구도, 자세, 표정, 장소, 사물을 영어 Danbooru 태그로 쉼표로 나눠 쓴다. 이름, 머리색, 눈색 같은 고정 외형과 옷은 쓰지 않는다. 코드가 붙인다.
- outfit: 설명에 옷이 나오면 사진에 보이는 사람의 이름마다 그 옷을 영어 Danbooru 태그로 쓴다. 옷 이야기가 없으면 빈 객체다.
- 설명에 없는 것을 지어내지 않는다.
JSON 하나만 출력한다: {"who":[],"tags":"","outfit":{}}

[사람]
${people.map((p) => p.name).join(", ")}

[사진 설명]
${desc}`;
		const raw = parseCard(await askModel([{
			role: "user",
			content: prompt
		}], null, "photo-plan"));
		if (!raw || typeof raw.tags !== "string") throw new Error("사진 장면 태그를 만들지 못했어요. 다시 시도해 주세요.");
		const idOf = (v) => typeof v === "string" ? findMember(people, v)?.id || "" : "";
		const who = [...new Set((Array.isArray(raw.who) ? raw.who : []).map(idOf).filter(Boolean))];
		const outfit = {};
		if (raw.outfit && typeof raw.outfit === "object" && !Array.isArray(raw.outfit)) for (const [k, v] of Object.entries(raw.outfit)) {
			const id = idOf(k), worn = cleanTags(v);
			if (id && worn && who.includes(id)) outfit[id] = worn;
		}
		return {
			who,
			tags: cleanTags(raw.tags),
			...Object.keys(outfit).length ? { outfit } : {}
		};
	}
	async function sendPhotoMessage(key, room, acct, sp, onPushed) {
		const desc = String(sp.desc || "").trim().slice(0, 1e3);
		const flags = acct === "me" ? {} : { typed: true };
		let photo;
		if (sp.mode === "draw") {
			if (!desc) throw new Error("어떤 사진인지 적어 주세요.");
			const plan = await planSentPhoto(states.get(key), room, acct, desc);
			photo = {
				...plan,
				desc,
				source: "draw",
				state: "pending",
				r18: room.r18 === true
			};
		} else {
			const picked = sp.picked;
			if (!picked) throw new Error("보낼 사진을 골라 주세요.");
			const stored = picked.kind === "photo" ? await copyPicture(picked) : await storePicture(await urlBytes(picked.kind === "asset" ? await imageUrl(picked.path) : picked.dataUrl));
			photo = {
				...stored,
				who: [],
				tags: "",
				...desc ? { desc } : {},
				source: sp.mode,
				state: "done",
				made: Date.now()
			};
		}
		const msg = {
			id: newId(),
			from: acct,
			text: "",
			t: Date.now(),
			photo,
			...flags
		};
		pushMessage(room, msg);
		await saveState(key);
		onPushed?.();
		render();
		if (photo.state === "pending") {
			await queuePhoto(key, room.id, msg.id);
			if (msg.photo.state !== "done") return;
		}
		await requestReply(key, room);
	}
	async function sendMessageRaw(key, room, text, from = "me", flags = {}) {
		pushMessage(room, {
			id: newId(),
			from,
			text,
			t: Date.now(),
			...flags
		});
		const saving = saveState(key).catch((e) => {
			console.log("[interlude] save failed: " + e.message);
			void systemFailure("storage", e, "send save failed");
		});
		await requestReply(key, room);
		await saving;
	}
	const sendMessage = systemInstrument("send", sendMessageRaw, (r, [, room]) => ({
		status: room.error ? "failed" : "success",
		error: room.error
	}));

//#endregion
//#region src/ui/screens/room.js
	function sendPhotoSheet(state, room, acct) {
		const sp = view.sendPhoto, key = view.key;
		const sender = personOf(state, acct);
		const set = (patch) => {
			Object.assign(sp, patch);
			render();
		};
		const close = () => {
			if (!sp.busy) {
				view.sendPhoto = null;
				render();
			}
		};
		const draw = sp.mode === "draw";
		const needTags = draw && acct === "me" && !hasImageTags({ imageTags: state.meImageTags });
		const desc = h("textarea", {
			rows: 3,
			"aria-label": draw ? "어떤 사진인가요?" : "사진 설명",
			"data-t": "photo-desc",
			placeholder: draw ? "예: 카페 창가에서 케이크 들고 찍은 셀카" : "비워도 돼요",
			oninput: (e) => {
				sp.desc = e.target.value;
				send.disabled = !ready();
			}
		}, sp.desc || "");
		const ready = () => !sp.busy && (draw ? imageReady() && !needTags && !!String(sp.desc || "").trim() : !!sp.picked);
		const preview = h("div", {
			class: "send-preview",
			"data-t": "photo-preview"
		});
		if (sp.picked) lazily(preview, () => (sp.picked.kind === "photo" ? photoThumb(sp.picked.photoId) : sp.picked.kind === "asset" ? imageUrl(sp.picked.path) : Promise.resolve(sp.picked.dataUrl)).then((url) => {
			if (url) preview.replaceChildren(h("img", {
				src: url,
				alt: "보낼 사진"
			}));
		}));
		const openPicker = () => {
			const seen = new Set();
			const chatPhotos = photosOf(state).filter(({ msg }) => !seen.has(msg.photo.id) && seen.add(msg.photo.id)).map(({ msg }) => ({
				name: `${personOf(state, msg.from)?.name || "사진"} · ${clock(msg.t)}`,
				path: "photo:" + msg.photo.id,
				photoId: msg.photo.id,
				w: msg.photo.w,
				h: msg.photo.h
			}));
			const sheet = h("div", {
				class: "picker-sheet",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": "사진 고르기",
				"data-t": "send-picker"
			}, h("div", { class: "top line-b" }, h("button", {
				class: "plain",
				"aria-label": "뒤로",
				"data-t": "send-picker-close",
				onclick: () => sheet.remove()
			}, icon("back", 24)), h("h1", { class: "small" }, "사진 고르기")), h("div", { class: "picker-body" }, assetGallery({ image: sp.picked?.path || "" }, state, view.assets || assetList(view.ctx.char), (a) => {
				sp.picked = a.photoId ? {
					kind: "photo",
					photoId: a.photoId,
					path: a.path,
					w: a.w,
					h: a.h
				} : {
					kind: "asset",
					path: a.path
				};
				sheet.remove();
				render();
			}, chatPhotos)));
			document.getElementById("win").append(sheet);
		};
		const file = h("input", {
			type: "file",
			accept: "image/*",
			"aria-label": "이미지 파일",
			"data-t": "photo-file",
			onchange: async () => {
				const f = file.files[0];
				if (!f) return;
				try {
					set({
						picked: {
							kind: "file",
							dataUrl: await readProfileFile(f),
							path: "file:" + f.name
						},
						error: ""
					});
				} catch {
					set({ error: "이미지 파일을 읽지 못했어요." });
				}
			}
		});
		const submit = async () => {
			if (!ready()) return;
			set({
				busy: true,
				error: ""
			});
			try {
				await sendPhotoMessage(key, room, acct, sp, () => {
					if (view.sendPhoto === sp) view.sendPhoto = null;
				});
			} catch (e) {
				sp.error = e.message;
			} finally {
				sp.busy = false;
				render();
			}
		};
		const send = h("button", {
			class: "pill primary grow",
			"data-t": "photo-send",
			disabled: !ready(),
			onclick: submit
		}, sp.busy ? draw ? "장면을 정하는 중…" : "보내는 중…" : draw ? "그려서 보내기" : "보내기");
		const mode = (id, label, ic) => h("button", {
			class: "act2" + (sp.mode === id ? " on" : ""),
			"aria-pressed": String(sp.mode === id),
			"data-t": "photo-mode-" + id,
			disabled: sp.busy,
			onclick: () => set({
				mode: id,
				picked: id === sp.mode ? sp.picked : null,
				error: ""
			})
		}, h("span", { class: "round" + (sp.mode === id ? " primary" : "") }, icon(ic)), label);
		return h("div", {
			class: "sheet-scrim",
			"data-t": "photo-sheet",
			onclick: (e) => {
				if (e.target === e.currentTarget) close();
			}
		}, h("div", {
			class: "send-sheet",
			role: "dialog",
			"aria-modal": "true",
			"aria-label": "사진 보내기"
		}, h("div", { class: "sect flush" }, "사진 보내기", h("small", {}, `보내는 사람: ${sender?.name || "나"}`)), h("div", { class: "acts" }, mode("draw", "새로 그리기", "pen"), mode("pick", "사진 고르기", "photo"), mode("upload", "기기에서 올리기", "download")), draw ? h("div", { class: "sub" }, `${sender?.name || "나"}의 외형 태그와 평소 옷으로 그려요. 옷을 바꾸려면 설명에 같이 써 주세요.`) : null, draw && !imageReady() ? h("div", {
			class: "notice flush",
			"data-t": "photo-not-ready"
		}, "설정 → 사진에서 사진 기능을, 설정 → 시작 준비에서 NovelAI 키를 확인해 주세요.") : null, needTags ? h("div", {
			class: "notice flush",
			"data-t": "photo-need-tags"
		}, "내가 나오는 사진을 그리려면 내 프로필에 사진 태그가 필요해요.", h("div", { class: "actions flush" }, h("button", {
			class: "pill",
			"data-t": "photo-open-me",
			onclick: () => {
				view.sendPhoto = null;
				go("me", {
					notice: "",
					meBioEdit: ""
				});
			}
		}, "내 프로필 열기"))) : null, sp.mode === "pick" ? h("button", {
			class: "pill",
			"data-t": "photo-pick",
			disabled: sp.busy,
			onclick: openPicker
		}, sp.picked ? "다른 사진 고르기" : "사진 고르기") : null, sp.mode === "upload" ? h("label", { class: "field flat" }, h("span", { class: "label" }, "이미지 파일"), file) : null, sp.picked && !draw ? preview : null, h("label", { class: "field flat" }, h("span", { class: "label" }, draw ? "어떤 사진인가요?" : "사진 설명 (비워도 돼요)"), desc), !draw ? h("div", { class: "sub" }, imageCfg.seePhotos === true ? "설명과 함께 사진도 모델에게 보여 줘요." : "모델에게는 설명만 보내요. 설정 → 사진에서 사진도 보여 주게 할 수 있어요.") : null, sp.error ? h("div", {
			class: "notice flush",
			role: "alert",
			"data-t": "photo-send-error"
		}, sp.error) : null, h("div", { class: "actions" }, h("button", {
			class: "pill",
			"data-t": "photo-cancel",
			disabled: sp.busy,
			onclick: close
		}, "취소"), send)));
	}
	function roomScreen(state) {
		const room = state.rooms.find((r) => r.id === view.roomId);
		if (!room) return listScreen(state);
		const acct = accountOf(), self = personOf(state, acct);
		const members = peopleOf(room).filter((id) => id !== acct).map((id) => personOf(state, id)).filter(Boolean), solo = room.type === "dm" ? roomPartner(state, room) : null;
		const isUser = (p) => p === view.me;
		const openPerson = (p) => isUser(p) ? go("me", {
			notice: "",
			meBioEdit: ""
		}) : openProfile(p.id);
		const busy = busyRooms.has(view.key + "|" + room.id) || !!view.polishing;
		const status = solo ? isUser(solo) ? state.meBio || "1:1 대화" : inStory(solo) ? "최근 대화에 이름 확인" : spell(displayBio(solo)) || "1:1 대화" : `${peopleOf(room).length}명 · ${members.map((m) => m.name).join(", ")}`;
		const who = h("button", {
			class: "who-btn",
			"aria-label": solo ? "프로필 보기" : roomTitle(state, room),
			"data-t": solo ? "room-profile" : null,
			onclick: () => {
				if (solo) openPerson(solo);
			}
		}, roomAvatar(state, room, 38, true), h("span", { class: "mid" }, h("span", { class: "nm" }, roomTitle(state, room)), h("span", { class: "st" }, status)));
		const head = h("div", { class: "top line-b" }, backBtn(() => go("list", {
			selecting: null,
			msgMenu: "",
			roomMenu: false
		})), who, h("button", {
			class: "plain",
			"aria-label": "대화방 관리",
			"aria-expanded": String(!!view.roomMenu),
			"data-t": "room-info",
			onclick: () => {
				view.roomMenu = !view.roomMenu;
				view.msgMenu = "";
				render();
			}
		}, icon("info", 22)), h("button", {
			class: "pill r18-toggle" + (room.r18 === true ? "" : " primary"),
			"aria-label": "정조대 모드 전환",
			"aria-pressed": String(room.r18 !== true),
			title: room.r18 === true ? "정조대 OFF · 이 방의 로컬 콘텐츠 제한 해제" : "정조대 ON · 기본 설정",
			"data-t": "room-r18",
			disabled: busy || !!view.r18Saving,
			onclick: async () => {
				if (view.r18Saving || busyRooms.has(view.key + "|" + room.id)) return;
				const key = view.key, previous = room.r18, previousMark = room.r18Mark;
				view.r18Saving = true;
				view.r18Error = "";
				room.r18 = room.r18 !== true;
				room.r18Mark = {
					msgId: room.msgs.at(-1)?.id || "",
					r18: room.r18,
					t: Date.now()
				};
				render();
				try {
					await saveState(key);
				} catch (e) {
					room.r18 = previous;
					if (previousMark === undefined) delete room.r18Mark;
					else room.r18Mark = previousMark;
					if (view.key === key && view.roomId === room.id) view.r18Error = "정조대 설정을 저장하지 못했어요.";
				} finally {
					view.r18Saving = false;
					render();
				}
			}
		}, room.r18 === true ? "정조대 OFF" : "정조대 ON"), closeBtn());
		const selecting = view.selecting instanceof Set ? view.selecting : null;
		const thread = h("div", {
			class: "thread",
			"data-t": "messages"
		});
		thread.append(solo ? h("div", { class: "hello" }, avatar(solo, 72), h("div", { class: "nm" }, solo.name), h("div", {
			class: "bio",
			"data-t": "hello-bio"
		}, isUser(solo) ? state.meBio || "" : spell(displayBio(solo))), h("button", {
			class: "pill",
			onclick: () => openPerson(solo)
		}, "프로필 보기")) : h("div", { class: "hello" }, roomAvatar(state, room, 72), h("div", { class: "nm" }, room.name), h("div", { class: "meta" }, `${members.map((m) => m.name).join(", ")}, 나`)));
		const sessionView = state.timeMode === "session";
		let shownSt = null;
		room.msgs.forEach((m, i) => {
			const prev = room.msgs[i - 1], next = room.msgs[i + 1];
			const gap = !prev || m.t - prev.t > 15 * 6e4, nextGap = !next || next.t - m.t > 15 * 6e4;
			const first = gap || prev.from !== m.from, last = nextGap || next.from !== m.from;
			if (sessionView) {
				if (m.st && stampText(m.st) !== stampText(shownSt)) {
					thread.append(h("div", {
						class: "time",
						"data-t": "session-time"
					}, sessionLine(m.st, shownSt)));
					shownSt = m.st;
				}
			} else if (gap) thread.append(h("div", { class: "time" }, clock(m.t)));
			const mine = m.from === acct, sender = personOf(state, m.from);
			const note = m.typed && m.text ? m.polished ? "다듬음" : "쓴 그대로 · 한 일만 기억해요" : "";
			const pos = first && last ? "" : first ? " g-first" : last ? " g-last" : " g-mid";
			const picked = selecting?.has(m.id);
			const toggle = (e) => {
				if (e.target.closest("button,a")) return;
				if (selecting) {
					picked ? selecting.delete(m.id) : selecting.add(m.id);
				} else view.msgMenu = view.msgMenu === m.id ? "" : m.id;
				render();
			};
			thread.append(h("div", {
				class: `msg${mine ? " me" : ""}${pos}${m.failed ? " failed" : ""}${picked ? " picked" : ""}`,
				"data-from": mine ? "me" : sender?.name || "",
				"data-id": m.id,
				onclick: toggle
			}, selecting ? h("span", {
				class: "tick",
				"data-t": "msg-tick",
				"aria-checked": String(!!picked),
				role: "checkbox"
			}) : null, mine ? null : h("span", { class: "slot" }, last ? avatar(sender, 28) : null), h("div", { class: "col" }, !mine && first && room.type === "group" ? h("div", { class: "sender" }, sender?.name || "") : null, m.photo ? photoBubble(room, m) : null, m.text ? h("div", {
				class: `b${m.text === "👍" ? " big" : ""}`,
				"data-t": "bubble"
			}, m.text) : null, m.editedAt ? h("small", {
				class: "sub",
				"data-t": "msg-edited"
			}, "수정됨") : null, note ? h("div", {
				class: "msg-note",
				"data-t": "msg-note"
			}, note) : null)));
			if (!selecting && view.msgMenu === m.id) thread.append(messageActions(state, room, m, i, busy));
		});
		if (view.editMessage?.key === view.key && view.editMessage.roomId === room.id) thread.append(messageEditPanel(room));
		const writingStory = storyWriting.has(view.key + "|" + room.id);
		if (busyRooms.has(view.key + "|" + room.id) && !view.editMessage?.saving) thread.append(h("div", {
			class: "msg",
			"data-t": "typing"
		}, h("span", { class: "slot" }, avatar(members[0], 28)), h("div", { class: "col" }, writingStory ? h("div", {
			class: "b typing story",
			role: "status",
			"data-t": "story-writing"
		}, h("span", { class: "spin small" }), "본편 줄거리 정리 중…") : h("div", {
			class: "b typing",
			"aria-label": "입력 중"
		}, h("i"), h("i"), h("i")))));
		if (room.error) {
			thread.append(h("div", {
				class: "error",
				"data-t": "error"
			}, `보내지 못했어요. ${room.error}`, h("div", { class: "actions flush" }, h("button", {
				class: "pill",
				"data-t": "retry",
				disabled: busy,
				onclick: () => requestReply(view.key, room)
			}, "다시 시도"), h("button", {
				class: "pill",
				"data-t": "open-system-log-error",
				onclick: openSystemLog
			}, "시스템 로그 보기"), h("button", {
				class: "pill",
				"data-t": "open-debug",
				onclick: openDebug
			}, "이전 답장 진단"))));
		}
		const input = h("textarea", {
			id: "draft",
			rows: 1,
			placeholder: acct === "me" ? "메시지 입력" : `${self?.name || "?"}(으)로 메시지`,
			"aria-label": "메시지",
			"data-t": "input"
		});
		input.value = view.draft || "";
		const sendBtn = h("button", {
			class: "plain",
			"data-t": "send",
			"aria-label": view.draft ? "보내기" : "좋아요 보내기",
			disabled: busy
		}, icon(view.draft ? "send" : "like", 24));
		const polish = view.polish?.key === view.key && view.polish.roomId === room.id ? view.polish : null;
		const runPolish = async (source, original = source) => {
			const key = view.key;
			view.polishing = true;
			view.polishError = "";
			render();
			try {
				const polished = await polishText(key, room, acct, source);
				if (view.key !== key || view.roomId !== room.id) return;
				view.polish = {
					key,
					roomId: room.id,
					original,
					polished
				};
				view.draft = polished;
			} catch (e) {
				view.polishError = "말투로 다듬지 못했어요. " + e.message;
			} finally {
				view.polishing = false;
				render();
			}
		};
		const submit = () => {
			if (busyRooms.has(view.key + "|" + room.id) || view.polishing) return;
			const text = input.value.trim() || "👍";
			if (acct !== "me" && !polish && text !== "👍" && chatValue(state, "polish") !== false) {
				view.draft = input.value;
				void runPolish(text);
				return;
			}
			view.draft = "";
			input.value = "";
			const flags = acct === "me" ? {} : {
				typed: true,
				...polish && text !== polish.original ? { polished: true } : {}
			};
			view.polish = null;
			view.polishError = "";
			sendMessage(view.key, room, text, acct, flags);
			input.focus();
		};
		const polishPanel = acct === "me" ? null : view.polishing ? h("div", {
			class: "polish",
			"data-t": "polishing"
		}, h("b", {}, `${self?.name || "?"} 말투로 다듬는 중…`)) : view.polishError ? h("div", {
			class: "polish",
			role: "alert",
			"data-t": "polish-error"
		}, view.polishError, h("div", { class: "actions flush" }, h("button", {
			class: "pill",
			"data-t": "polish-retry",
			onclick: () => runPolish(input.value.trim())
		}, "다시 다듬기"), h("button", {
			class: "pill",
			"data-t": "polish-skip",
			onclick: () => {
				view.polish = {
					key: view.key,
					roomId: room.id,
					original: input.value.trim(),
					polished: input.value.trim()
				};
				view.polishError = "";
				render();
			}
		}, "쓴 그대로 보내기"))) : polish ? h("div", {
			class: "polish",
			"data-t": "polish-panel"
		}, h("b", {}, `${self?.name || "?"} 말투로 다듬었어요 · 고쳐도 되고, 다시 누르면 보내요`), h("div", {
			class: "sub",
			"data-t": "polish-original"
		}, `쓴 글: ${polish.original}`), h("div", { class: "actions flush" }, h("button", {
			class: "pill",
			"data-t": "polish-revert",
			onclick: () => {
				view.draft = polish.original;
				view.polish = {
					...polish,
					polished: polish.original
				};
				render();
			}
		}, "쓴 글로 되돌리기"), h("button", {
			class: "pill",
			"data-t": "polish-again",
			onclick: () => runPolish(input.value.trim() || polish.original, polish.original)
		}, "다시 다듬기"), h("button", {
			class: "pill",
			"data-t": "polish-close",
			onclick: () => {
				view.draft = polish.original;
				view.polish = null;
				render();
			}
		}, "닫기"))) : null;
		sendBtn.addEventListener("click", submit);
		const fit = () => {
			input.style.height = "40px";
			input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
		};
		input.addEventListener("input", () => {
			view.draft = input.value;
			fit();
			sendBtn.replaceChildren(icon(view.draft ? "send" : "like", 24));
			sendBtn.setAttribute("aria-label", view.draft ? "보내기" : "좋아요 보내기");
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.innerWidth >= 768 && input.value.trim()) {
				e.preventDefault();
				submit();
			}
		});
		input.addEventListener("focus", () => setTimeout(() => input.scrollIntoView({ block: "nearest" }), 300));
		requestAnimationFrame(fit);
		const bottom = selecting ? h("div", {
			class: "selbar",
			"data-t": "select-bar"
		}, h("button", {
			class: "pill",
			"data-t": "select-cancel",
			onclick: () => {
				view.selecting = null;
				render();
			}
		}, "취소"), h("span", { class: "mid" }, `${selecting.size}개 선택`), h("button", {
			class: "pill danger",
			"data-t": "select-delete",
			disabled: !selecting.size || busy,
			onclick: async () => {
				await deleteMessages(room, [...selecting]);
				view.selecting = null;
				render();
			}
		}, `${selecting.size}개 삭제`)) : h("div", { class: "composer" }, h("button", {
			class: "plain",
			"data-t": "photo-send-open",
			"aria-label": "사진 보내기",
			disabled: busy,
			onclick: () => {
				view.sendPhoto = {
					key: view.key,
					roomId: room.id,
					mode: imageReady() ? "draw" : "pick",
					desc: "",
					picked: null,
					busy: false,
					error: ""
				};
				render();
			}
		}, icon("photo", 24)), input, sendBtn);
		return [
			head,
			view.r18Error ? h("div", {
				class: "error",
				"data-t": "room-r18-error"
			}, view.r18Error) : null,
			view.roomMenu ? roomMenuPanel(state, room, busy) : null,
			h("div", {
				class: "scroll",
				id: "scroll"
			}, thread),
			selecting ? null : polishPanel,
			bottom,
			view.sendPhoto?.key === view.key && view.sendPhoto.roomId === room.id ? sendPhotoSheet(state, room, acct) : null
		].filter(Boolean);
	}

//#endregion
//#region src/ui/screens/terms.js
	async function changeTerm(fn) {
		fn();
		await saveTerms();
		render();
	}
	function termsScreen(state) {
		const q = normalize(view.termQuery);
		const rows = termDict.filter((t) => !q || normalize(t.from).includes(q) || normalize(t.to).includes(q)).sort((a, b) => a.from.localeCompare(b.from));
		const fromInput = h("input", {
			type: "text",
			placeholder: "원문 또는 틀린 표기",
			"aria-label": "원문",
			"data-t": "dict-from"
		});
		const toInput = h("input", {
			type: "text",
			placeholder: "바꿀 표기",
			"aria-label": "바꿀 표기",
			"data-t": "dict-to"
		});
		const add = () => {
			const from = fromInput.value.trim(), to = toInput.value.trim();
			if (!from || !to) return;
			changeTerm(() => {
				const known = termDict.find((t) => t.from === from);
				if (known) Object.assign(known, {
					to,
					source: "user"
				});
				else termDict.push({
					from,
					to,
					source: "user"
				});
			});
		};
		const job = view.termJob;
		return [h("div", { class: "top line-b" }, backBtn(() => go("set-manage")), h("h1", { class: "small" }, "단어 사전"), closeBtn()), h("div", {
			class: "scroll",
			id: "scroll"
		}, h("section", { class: "card first" }, h("div", { class: "sub" }, "분석본의 고유명사를 AI가 한글로 정리한 목록이에요. 이 봇의 모든 챗에 적용됩니다. 틀린 표기만 고치면 돼요."), h("div", { class: "actions flush" }, h("button", {
			class: "pill",
			"data-t": "dict-generate",
			disabled: !!job,
			onclick: () => generateTerms(state)
		}, job ? "만드는 중…" : "새 단어 채우기")), view.termNotice ? h("div", {
			class: "notice flush top-gap",
			"data-t": "dict-notice"
		}, view.termNotice) : null), h("section", { class: "card" }, h("h3", {}, "단어 추가"), h("div", { class: "pair" }, fromInput, toInput), h("div", { class: "actions flush" }, h("button", {
			class: "pill primary",
			"data-t": "dict-add",
			onclick: add
		}, "추가"))), h("section", { class: "card" }, h("h3", {}, "단어 목록", h("small", { "data-t": "dict-count" }, `${termDict.length}개`)), termDict.length > 8 ? h("label", { class: "search flush" }, icon("search", 16), h("input", {
			id: "tq",
			value: view.termQuery || "",
			placeholder: "단어 찾기",
			"aria-label": "단어 찾기",
			oninput: (e) => {
				view.termQuery = e.target.value;
				render(e.target);
			}
		})) : null, rows.length ? rows.map((t) => h("div", {
			class: "term",
			"data-t": "dict-item",
			"data-name": t.from
		}, h("div", { class: "mid" }, h("div", { class: "tx from" }, t.from), h("input", {
			type: "text",
			value: t.to,
			"aria-label": `${t.from}의 표기`,
			"data-t": "dict-value",
			"data-name": t.from,
			onchange: (e) => {
				const value = e.target.value.trim();
				if (value) changeTerm(() => {
					t.to = value;
					t.source = "user";
				});
			}
		})), h("button", {
			class: "plain",
			"aria-label": `${t.from} 삭제`,
			"data-t": "dict-del",
			"data-name": t.from,
			onclick: () => changeTerm(() => {
				termDict.splice(termDict.indexOf(t), 1);
			})
		}, icon("close", 18)))) : h("div", { class: "sub" }, "아직 단어가 없어요. 인물을 분석하면 채워집니다.")))];
	}

//#endregion
//#region src/ui/render.js
	let composing = null;
	let renderLater = false;
	document.addEventListener("compositionstart", (e) => {
		composing = e.target;
	}, true);
	document.addEventListener("compositionend", () => {
		composing = null;
		if (renderLater) {
			renderLater = false;
			render();
		}
	}, true);
	const isTextBox = (e) => e?.tagName === "TEXTAREA" || e?.tagName === "INPUT" && [
		"text",
		"search",
		"password",
		"number",
		""
	].includes(e.getAttribute("type") || "");
	const boxKey = (e) => e.dataset?.t ? `[data-t="${e.dataset.t}"]` + (e.dataset.name ? `[data-name="${e.dataset.name.replace(/["\\]/g, "\\$&")}"]` : "") : "";
	function render(live) {
		if (!live && composing?.isConnected && document.getElementById("win")?.contains(composing)) {
			renderLater = true;
			return;
		}
		renderLater = false;
		if (view.open && view.screen === "system-log") {
			document.getElementById("win")?.replaceChildren(...systemScreen());
			return;
		}
		if (!view.key || !view.open) return;
		const state = states.get(view.key);
		if (!state) return;
		const active = document.activeElement, focusId = active?.id, caret = active?.selectionStart;
		const typed = !focusId && isTextBox(active) && document.getElementById("win")?.contains(active) && boxKey(active) ? {
			key: boxKey(active),
			value: active.value,
			screen: view.screen
		} : null;
		const oldScroll = document.getElementById("scroll");
		const atBottom = oldScroll ? oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight < 80 : true;
		const keep = oldScroll && view.lastScreen === view.screen ? oldScroll.scrollTop : 0;
		const shared = [
			"settings",
			"set-setup",
			"set-manage",
			"style-edit",
			"terms",
			"modules",
			"set-backup",
			"debug"
		];
		const screen = !state.enabled && !shared.includes(view.screen) ? settingsScreen : view.screen === "context-settings" ? contextSettingsScreen : view.screen === "switch" ? switchScreen : view.screen === "me" ? myProfileScreen : view.screen === "set-talk" ? chatSettingsScreen : view.screen === "set-photo" ? photoSettingsScreen : view.screen === "set-setup" ? setupSettingsScreen : view.screen === "set-manage" ? manageSettingsScreen : view.screen === "set-backup" ? backupSettingsScreen : view.screen === "room" ? roomScreen : view.screen === "profile" ? profileScreen : view.screen === "edit" ? editScreen : view.screen === "group" ? groupScreen : view.screen === "pick" ? pickScreen : view.screen === "reanalyze" ? reanalyzeScreen : view.screen === "terms" ? termsScreen : view.screen === "modules" ? modulesScreen : view.screen === "my-photo" ? myPhotoScreen : view.screen === "settings" ? settingsScreen : view.screen === "style-edit" ? styleEditScreen : view.screen === "bot-apply" ? botApplyScreen : view.screen === "bot-budget" ? botBudgetScreen : view.screen === "debug" ? debugScreen : listScreen;
		const nodes = screen(state);
		const kept = live ? keepAround(document.getElementById("win"), nodes, live) : false;
		if (!kept) document.getElementById("win").replaceChildren(...nodes);
		const deletion = chatDeletionPanel(state);
		if (deletion) document.getElementById("win").append(deletion);
		const updateSettings = updateSettingsPanel(state);
		if (updateSettings) document.getElementById("win").append(updateSettings);
		const followAll = followAllPanel(state);
		if (followAll) document.getElementById("win").append(followAll);
		if (view.viewer && state.enabled) {
			const overlay = viewerOverlay(state);
			if (overlay) document.getElementById("win").append(overlay);
		}
		refreshJobBar();
		const scroll = document.getElementById("scroll");
		if (scroll) scroll.scrollTop = view.screen === "room" && (atBottom || view.roomJustOpened) ? scroll.scrollHeight : keep;
		view.roomJustOpened = false;
		view.lastScreen = view.screen;
		if (focusId && !kept) {
			const again = document.getElementById(focusId);
			if (again) {
				again.focus();
				if (typeof caret === "number") again.setSelectionRange?.(caret, caret);
			}
		}
		const box = typed && typed.screen === view.screen ? document.getElementById("win").querySelector(typed.key) : null;
		if (box && isTextBox(box)) {
			if (box.value !== typed.value) {
				box.value = typed.value;
				box.dispatchEvent(new Event("input", { bubbles: true }));
			}
			box.focus();
			if (typeof caret === "number") {
				try {
					box.setSelectionRange(caret, caret);
				} catch {}
			}
		}
	}
	function keepAround(win, nodes, live) {
		if (!live.id || !win.contains(live)) return false;
		const holder = document.createElement("div");
		holder.append(...nodes);
		const fresh = holder.querySelector(`[id="${live.id}"]`);
		if (!fresh) return false;
		const oldChain = [], newChain = [];
		for (let n = live; n !== win; n = n.parentNode) oldChain.unshift(n);
		for (let n = fresh; n !== holder; n = n.parentNode) newChain.unshift(n);
		if (oldChain.length !== newChain.length || oldChain.some((n, i) => n.tagName !== newChain[i].tagName)) return false;
		let oldParent = win, newParent = holder;
		oldChain.forEach((old, i) => {
			const next = newChain[i];
			for (const child of [...oldParent.childNodes]) if (child !== old) child.remove();
			let before = true;
			for (const child of [...newParent.childNodes]) {
				if (child === next) before = false;
				else if (before) oldParent.insertBefore(child, old);
				else oldParent.append(child);
			}
			if (old !== live) {
				old.className = next.className;
				old.style.cssText = next.style.cssText;
			}
			oldParent = old;
			newParent = next;
		});
		return true;
	}

//#endregion
//#region src/people/terms.js
	let termDict = [];
	let termKey = "";
	async function loadTermsRaw(chaId) {
		const key = TERMS_PREFIX + chaId;
		if (termKey === key) return { status: "skipped" };
		termKey = key;
		termDict = [];
		try {
			let saved = await risuai.pluginStorage.getItem(key);
			if (typeof saved === "string") saved = JSON.parse(saved);
			if (Array.isArray(saved)) termDict = saved;
		} catch (e) {
			console.log("[interlude] dictionary failed: " + e.message);
			return {
				status: "failed",
				error: e.message
			};
		}
	}
	const loadTerms = systemInstrument("load", loadTermsRaw, (r) => r);
	async function saveTermsRaw() {
		await risuai.pluginStorage.setItem(termKey, JSON.stringify(termDict));
	}
	const saveTerms = systemInstrument("storage", saveTermsRaw);
	function spell(text) {
		let out = String(text ?? "");
		for (const t of termDict.slice().sort((a, b) => b.from.length - a.from.length)) {
			if (!t.from || !t.to || t.from === t.to) continue;
			const body = t.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			out = out.replace(new RegExp(/[a-z]/i.test(t.from) ? `(?<![a-z])${body}(?![a-z])` : body, "gi"), t.to);
		}
		return out;
	}
	function cardSourceTerms(contacts) {
		const terms = new Set();
		for (const c of contacts) {
			const card = c.card;
			if (!card) continue;
			for (const raw of [
				card["소속"],
				card["직책"],
				...Array.isArray(card["고유명사"]) ? card["고유명사"] : []
			]) {
				const term = String(raw || "").trim();
				if (term && /[a-z]/i.test(term) && !/[가-힣]/.test(term) && term.length <= 40) terms.add(term);
			}
			for (const line of [c.manualBio ? "" : c.bio, card["정체"]]) {
				for (const found of String(line || "").match(/[A-Za-z][A-Za-z'&.-]+(?:\s+[A-Za-z][A-Za-z'&.-]+)*/g) || []) if (found.length >= 3 && found.length <= 40) terms.add(found);
			}
		}
		return [...terms];
	}
	const HANGUL_ONLY = /^[가-힣][가-힣\s]*$/;
	function loreTermPairs(books) {
		const pairs = new Map();
		for (const entry of books) {
			const names = [baseTitle(loreTitle(entry)), ...String(entry.key || "").split(",")].map((k) => k.trim()).filter(Boolean);
			const korean = [...new Set(names.filter((k) => HANGUL_ONLY.test(k) && k.length >= 2))];
			const latin = [...new Set(names.filter((k) => /^[a-z][a-z\s'&.-]{2,}$/i.test(k)))];
			for (const original of latin) {
				const target = normalize(original);
				let best = "", bestScore = Infinity;
				for (const word of korean) {
					for (const sound of romajiVariants(word.replace(/\s+/g, ""))) {
						const score = editDistance(sound, target) / Math.max(sound.length, target.length);
						if (score < bestScore) {
							bestScore = score;
							best = word;
						}
					}
				}
				if (best && bestScore <= .34 && !pairs.has(target)) pairs.set(target, {
					from: original,
					to: best
				});
			}
		}
		return [...pairs.values()];
	}
	function loreKoreanWords(books) {
		const named = new Set();
		for (const entry of books) {
			for (const name of [baseTitle(loreTitle(entry)), ...String(entry.key || "").split(",")]) {
				const word = name.trim();
				if (HANGUL_ONLY.test(word) && word.length >= 2) named.add(word);
			}
		}
		return [...named, ...loreContentWords(books).filter((w) => !named.has(w))].slice(0, 800);
	}
	function loreContentWords(books) {
		const counts = new Map();
		for (const entry of books) {
			for (const word of String(entry.content || "").match(/[가-힣]{2,}/g) || []) counts.set(word, (counts.get(word) || 0) + 1);
		}
		return [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 300).map(([w]) => w);
	}
	async function generateTermsRaw(state) {
		if (view.termJob) return;
		const books = await loreBooks();
		const known = new Set(termDict.map((t) => normalize(t.from)));
		for (const pair of loreTermPairs(books)) {
			if (known.has(normalize(pair.from))) continue;
			known.add(normalize(pair.from));
			termDict.push({
				...pair,
				source: "lore"
			});
		}
		await saveTerms();
		const missing = cardSourceTerms(state.contacts).filter((t) => !known.has(normalize(t)));
		if (!missing.length) {
			view.termNotice = "새로 정리할 단어가 없어요.";
			render();
			return { status: "skipped" };
		}
		const job = view.termJob = { stop: false };
		view.termNotice = "";
		render();
		let failed = 0;
		try {
			const words = loreKoreanWords(books).join(", ");
			const batches = [];
			for (let i = 0; i < missing.length; i += TERM_BATCH) batches.push(missing.slice(i, i + TERM_BATCH));
			await inPool(batches, 2, async (batch) => {
				if (job.stop) return;
				const wanted = new Map(batch.map((t) => [normalize(t), t]));
				try {
					const reply = await askModel([{
						role: "user",
						content: `아래 용어의 한글 표기를 정한다.
규칙:
- [로어북의 한글 표기]는 이 봇이 실제로 쓰는 말이다. 같은 뜻의 말이 있으면 반드시 그 표기를 그대로 쓴다.
- 목록에 없으면 널리 쓰이는 한국어 표기를 쓰고, 확실하지 않으면 원문을 그대로 쓴다.
- 설명 없이 한 줄에 하나씩 다음 형식으로만 출력한다:
원문|한글 표기

[용어]
${batch.join("\n")}

[로어북의 한글 표기]
${words}`
					}], null, "terms");
					for (const [from, to] of parseLines(reply)) {
						const original = wanted.get(normalize(from));
						if (original && to && !termDict.some((t) => normalize(t.from) === normalize(original))) termDict.push({
							from: original,
							to,
							source: "auto"
						});
					}
				} catch (e) {
					failed++;
					view.termError = e.message;
				}
			});
			await saveTerms();
			view.termNotice = job.stop ? "단어 정리를 멈췄어요. 새 단어 채우기로 이어서 할 수 있어요." : failed ? `일부 단어를 정리하지 못했어요. (${view.termError})` : "";
			return {
				status: job.stop ? "cancelled" : failed ? "partial" : "success",
				error: failed ? view.termError : ""
			};
		} finally {
			view.termJob = null;
			render();
		}
	}
	const generateTerms = systemInstrument("terms", generateTermsRaw, (r) => r || { status: "skipped" });
	function editDistance(a, b) {
		const row = Array.from({ length: b.length + 1 }, (_, i) => i);
		for (let i = 1; i <= a.length; i++) {
			let prev = row[0];
			row[0] = i;
			for (let j = 1; j <= b.length; j++) {
				const keep = row[j];
				row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
				prev = keep;
			}
		}
		return row[b.length];
	}
	function cardWords(members) {
		const words = new Set();
		for (const m of members) {
			const c = m.card;
			if (!c || m.cardSchema !== 2 || m.analysisStale) continue;
			for (const raw of [
				c["소속"],
				c["직책"],
				...Array.isArray(c["고유명사"]) ? c["고유명사"] : []
			]) {
				for (const word of spell(raw).split(/\s+/)) if (/^[가-힣]{4,}$/.test(word)) words.add(word);
			}
		}
		return [...words];
	}
	function fixTerms(text, members) {
		const words = cardWords(members);
		return spell(text).replace(/[가-힣]{4,}/g, (token) => {
			if (words.some((w) => token.startsWith(w))) return token;
			for (const word of words) {
				const stem = token.slice(0, word.length);
				if (stem.length === word.length && stem[0] === word[0] && stem[stem.length - 1] === word[word.length - 1] && editDistance(stem, word) <= 2) {
					return word + token.slice(word.length);
				}
			}
			return token;
		});
	}
	function relevantLines(lore, lastText, r18 = false) {
		const words = (String(lastText || "").match(/[가-힣a-zA-Z]{2,}/g) || []).filter((w) => !/^(오늘|지금|그럼|근데|그리고|뭐해|어때|있어|없어|잘|좀|많이|진짜)$/.test(w)).map((w) => w.replace(/(은|는|이|가|을|를|에|의|도|로|와|과|랑|하고|에서)$/, "")).filter((w) => w.length >= 2);
		if (!words.length) return "";
		const lines = lore.split(/\n+/).map((l) => l.trim()).filter((l) => l && (r18 || !EXPLICIT_ASSET.test(l)) && words.some((w) => l.includes(w)));
		return lines.join("\n").slice(0, RELEVANT_LORE);
	}
	async function memberLore(ctx, members, lastText, state, report = [], room = null) {
		const books = await loreBooks();
		const blocks = [];
		const budget = contextBudget(state);
		let left = budget.replyTotal;
		for (const member of members) {
			const source = await memberLoreSource(member, books);
			const lore = cardLore(member, source, budget.analysis);
			const note = member.cardNote ? `\n사용자 메모(가장 우선): ${member.cardNote}` : "";
			let text;
			const verified = member.card && member.cardSchema === 2 && (member.analysisLore ? member.analysisLore === lore : member.loreHash === loreHash(lore)) ? verifiedSharedCard(member.card, lore) : null;
			if (verified) {
				const extra = relevantLines(lore, lastText, room?.r18 === true);
				text = cardText({
					...member,
					card: verified
				}) + note + (extra ? `\n관련 설정:\n${spell(extra)}` : "");
			} else {
				text = source + note;
			}
			text = budgetText(text, Math.min(budget.replyMember, left), "member", report, member.id);
			if (!text) continue;
			left -= text.length;
			blocks.push(`## ${member.name}\n${text}`);
		}
		return blocks.join("\n\n");
	}
	function roomMembers(state, room) {
		return room.members.map((id) => state.contacts.find((c) => c.id === id)).filter(Boolean);
	}

//#endregion
//#region src/people/analysis.js
	function loreHash(text) {
		let hash = 0;
		for (let i = 0; i < text.length; i++) hash = hash * 31 + text.charCodeAt(i) | 0;
		return String(hash);
	}
	function findLoreEntry(member, books) {
		const needles = [
			member.lore,
			member.name,
			...member.aliases || []
		].map(normalize).filter((n) => n.length >= 2);
		return member.lore && books.find((e) => normalize(loreTitle(e)) === normalize(member.lore)) || books.find((e) => normalize(loreTitle(e)) === normalize(member.name)) || books.find((e) => needles.some((n) => normalize(baseTitle(loreTitle(e))) === n)) || books.find((e) => needles.some((n) => n.length >= 2 && normalize(loreTitle(e)).includes(n))) || books.find((e) => needles.some((n) => String(e.key || "").split(",").some((k) => normalize(k) === n)));
	}
	async function memberLoreSource(member, books) {
		const entry = findLoreEntry(member, books);
		return entry ? cleanStory(await parseCbs(entry.content)) : "";
	}
	async function memberLoreText(member, books, limit = LORE_PER_MEMBER, report) {
		return budgetText(await memberLoreSource(member, books), limit, "analysis", report, member.id);
	}
	const CARD_FIRST = /name|identity|occupation|role|affiliation|personality|core|speech|dialogue|relationship|belief|value|goal|motivation|social|emotion|behavio|habit|이름|정체|직업|소속|직책|성격|말투|대사|관계|가치|목표|습관|감정/i;
	const CARD_LAST = /appearance|body|physical|outfit|cloth|sexual|kink|fetish|nsfw|외모|외형|신체|복장|의상|성적|성향|성생활/i;
	function cardFocus(text, limit) {
		if (text.length <= limit) return text;
		const starts = [0];
		const re = /\n(?=#{1,6} |[*-] ?[^\n:]{1,40}:|\[[^\]\n]{1,40}\]|<[^>\n]{1,40}>)/g;
		for (let m; m = re.exec(text);) starts.push(m.index + 1);
		if (starts.length < 3) return text.slice(0, limit);
		const parts = starts.map((s, i) => ({
			i,
			text: text.slice(s, starts[i + 1] ?? text.length)
		}));
		const head = (p) => p.text.split("\n")[0].replace(/^[#*\-\s[<]+/, "").split(/[:\]>{]/)[0];
		const rank = (p) => CARD_LAST.test(head(p)) ? 2 : p.i === 0 || CARD_FIRST.test(head(p)) ? 0 : 1;
		const picked = new Set();
		let left = limit;
		for (const r of [
			0,
			1,
			2
		]) for (const p of parts) {
			if (rank(p) !== r || p.text.length > left) continue;
			picked.add(p.i);
			left -= p.text.length;
		}
		if (!picked.size) return text.slice(0, limit);
		return parts.filter((p) => picked.has(p.i)).map((p) => p.text).join("");
	}
	function cardLore(member, source, limit, fresh = false) {
		const plain = source.slice(0, limit);
		if (!fresh && member.card && (member.analysisLore ? member.analysisLore === plain : member.loreHash === loreHash(plain))) return plain;
		return cardFocus(source, limit);
	}
	async function memberCardText(member, books, limit = LORE_PER_MEMBER, report, fresh = false) {
		const source = await memberLoreSource(member, books), cap = Math.max(0, limit);
		const text = cardLore(member, source, cap, fresh);
		if (report) report.push({
			section: "analysis",
			memberId: member.id,
			sourceChars: source.length,
			usedChars: text.length,
			limit: cap,
			truncated: text.length < source.length
		});
		return text;
	}
	function parseCard(text) {
		const end = text.lastIndexOf("}");
		let start = text.indexOf("{");
		for (let tries = 0; start >= 0 && start < end && tries < 30; tries++) {
			try {
				const card = JSON.parse(text.slice(start, end + 1));
				if (card && typeof card === "object" && !Array.isArray(card)) return card;
			} catch {}
			start = text.indexOf("{", start + 1);
		}
		return null;
	}
	const CARD_KEY_NAMES = {
		"이름": ["name", "성명"],
		"정체": [
			"identity",
			"신분",
			"정체성"
		],
		"소속": [
			"affiliation",
			"소속단체",
			"소속기관",
			"organization",
			"organisation"
		],
		"직책": [
			"position",
			"직위",
			"직업",
			"occupation",
			"job"
		],
		"1인칭": [
			"first_person",
			"일인칭",
			"1인칭대명사",
			"자칭",
			"firstpersonpronoun"
		],
		"말투": [
			"speech",
			"말",
			"어투",
			"말씨",
			"화법",
			"어조",
			"말버릇",
			"말투특징",
			"speechstyle",
			"speakingstyle",
			"speechpattern",
			"tone"
		],
		"대사예시": [
			"example_lines",
			"대사",
			"예시대사",
			"대사예",
			"예시",
			"sampledialogue",
			"dialogueexamples"
		],
		"관계": [
			"relations",
			"인간관계",
			"인물관계",
			"relationships"
		],
		"고유명사": ["proper_nouns", "propernoun"],
		"호칭관계": [
			"address_rules",
			"호칭",
			"호칭목록",
			"addressing",
			"formsofaddress"
		],
		"근거": [
			"evidence",
			"출처",
			"인용",
			"원문",
			"원문근거",
			"sources",
			"citations"
		]
	};
	const cardKey = (k) => String(k).toLowerCase().replace(/[\s_\-·.]/g, "");
	const CARD_KEY_OF = new Map(Object.entries(CARD_KEY_NAMES).flatMap(([field, names]) => [field, ...names].map((n) => [cardKey(n), field])));
	function canonicalKeys(obj) {
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
		const out = {};
		for (const [k, v] of Object.entries(obj)) if (Object.hasOwn(CARD_KEY_NAMES, k)) out[k] = v;
		for (const [k, v] of Object.entries(obj)) {
			const field = CARD_KEY_OF.get(cardKey(k));
			if (field && !(field in out)) out[field] = v;
			else if (!field && !(k in out)) out[k] = v;
		}
		return out;
	}
	function canonicalCard(card) {
		const out = canonicalKeys(card);
		if (!out || typeof out !== "object") return out;
		if (out["근거"]) out["근거"] = canonicalKeys(out["근거"]);
		const pick = (o, ...keys) => {
			for (const k of keys) if (o?.[k] !== undefined) return o[k];
			return undefined;
		};
		if (Array.isArray(out["호칭관계"])) out["호칭관계"] = out["호칭관계"].map((r) => r && typeof r === "object" ? {
			"대상": pick(r, "대상", "target"),
			"호칭": pick(r, "호칭", "address"),
			"근거": pick(r, "근거", "quote", "evidence")
		} : r);
		if (Array.isArray(out["관계"])) out["관계"] = out["관계"].map((r) => {
			if (!r || typeof r !== "object" || Array.isArray(r)) return r;
			const who = pick(r, "대상", "target", "name"), what = pick(r, "관계", "relation", "relationship");
			return typeof who === "string" && typeof what === "string" ? `${who}: ${what}` : r;
		});
		return out;
	}
	function verifyCard(card, lore) {
		card = canonicalCard(card) || {};
		const text = (v) => typeof v === "string" ? v.trim() : "";
		const hay = String(lore).replace(/\s+/g, " ");
		const bare = String(lore).replace(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]+/gm, "").replace(/\s+/g, " ");
		const exact = (q) => text(q).length >= 2 && [hay, bare].some((h) => h.includes(text(q).replace(/\s+/g, " ")));
		const quoted = (q) => {
			if (exact(q)) return true;
			const pieces = text(q).split(/\s*(?:\||…|\.{3})\s*|\s+\/\s+/).map((p) => p.trim()).filter(Boolean);
			if (pieces.length > 1 && pieces.some((p) => p.length >= 4) && pieces.every(exact)) return true;
			const sentences = text(q).split(/(?<=[.!?。])\s+/).map((p) => p.trim()).filter(Boolean);
			return sentences.length > 1 && sentences.every((p) => p.length >= 4 && exact(p));
		};
		const result = {
			"근거": {},
			"상대호칭": "",
			"호칭관계": [],
			"금지": [],
			"다른이름": []
		};
		for (const field of [
			"이름",
			"정체",
			"소속",
			"직책",
			"1인칭",
			"말투"
		]) {
			const value = text(card[field]), quote = text(card["근거"]?.[field]);
			result[field] = value && value.length <= 400 && quoted(quote) ? value : "";
			if (field === "1인칭" && !quote.includes(value)) result[field] = "";
			if (result[field]) result["근거"][field] = quote;
		}
		for (const field of ["관계", "고유명사"]) {
			const values = Array.isArray(card[field]) ? card[field] : [];
			const quotes = Array.isArray(card["근거"]?.[field]) ? card["근거"][field] : [];
			const kept = values.map((value, i) => ({
				value: text(value),
				quote: text(quotes[i])
			})).filter((x) => x.value && x.value.length <= 300 && quoted(x.quote) && (field !== "고유명사" || normalize(x.quote).includes(normalize(x.value))));
			result[field] = kept.slice(0, 12).map((x) => x.value);
			result["근거"][field] = kept.slice(0, 12).map((x) => x.quote);
		}
		for (const rule of Array.isArray(card["호칭관계"]) ? card["호칭관계"] : []) {
			const target = text(rule?.["대상"]), address = text(rule?.["호칭"]), quote = text(rule?.["근거"]);
			if (!target || !address || target.length > 60 || address.length > 40 || !quoted(quote)) continue;
			if (!normalize(quote).includes(normalize(target)) || !quote.includes(address)) continue;
			result["호칭관계"].push({
				"대상": target,
				"호칭": address,
				"근거": quote
			});
			if (result["호칭관계"].length >= 12) break;
		}
		result["대사예시"] = (Array.isArray(card["대사예시"]) ? card["대사예시"] : []).filter((q) => typeof q === "string" && exact(q)).slice(0, 3);
		result["한줄소개"] = profileBio(card["한줄소개"]);
		result.bioSchema = card.bioSchema === 1 && result["한줄소개"] ? 1 : 0;
		return result;
	}
	function profileBio(value) {
		if (typeof value !== "string") return "";
		const bio = value.trim().replace(/^["“「]|["”」]$/g, "").replace(/\s+/g, " ");
		if (!bio || Array.from(bio).length > 25 || !/[가-힣]/.test(bio) || /[a-z]/i.test(bio)) return "";
		if (/^(없음|미상|알 수 없음|한줄소개|한줄 소개|상태메시지|상태 메시지)[.!]?$/.test(bio)) return "";
		if (/(?:캐릭터|인물)(?:이다|입니다)?[.!]?$/.test(bio)) return "";
		return bio;
	}
	function displayBio(contact) {
		return contact?.manualBio ? String(contact.bio || "") : profileBio(contact?.bio);
	}
	function cardText(contact) {
		const c = contact.card;
		if (!c || contact.cardSchema !== 2) return "";
		const line = (label, value) => {
			const text = Array.isArray(value) ? value.filter(Boolean).join(", ") : value;
			return text ? `${label}: ${text}` : "";
		};
		return [
			line("이름", contact.name),
			line("정체", c["정체"]),
			line("소속", c["소속"]),
			line("직책", c["직책"]),
			line("1인칭", c["1인칭"]),
			line("말투", c["말투"]),
			line("설정상의 관계 (현재 수신자와 동일하다는 뜻이 아님)", c["관계"]),
			line("고유명사", c["고유명사"])
		].filter(Boolean).map(spell).join("\n");
	}
	const sharedAnalysisJobs = new Map();
	const sharedBioJobs = new Map();
	function sharedAnalysisKey(botId, contact, lore) {
		return "interlude:analysis:v2:" + encodeURIComponent(botId) + ":" + encodeURIComponent(personKey(contact)) + ":" + loreHash(lore);
	}
	async function ensureCardBioRaw(contact, card, lore, options = {}) {
		if (contact.manualBio && !options.forceBio) return card;
		if (!options.forceBio && card.bioSchema === 1 && profileBio(card["한줄소개"])) {
			contact.bioError = "";
			return card;
		}
		const key = sharedAnalysisKey(options.botId || "local", contact, lore) + ":bio:" + lore;
		let job = sharedBioJobs.get(key);
		if (!job) {
			job = (async () => {
				const prompt = `인물 "${contact.name}"이 자기 메신저 프로필에 직접 써 두는 짧은 상태메시지를 작성한다.
이것은 로어의 사실 요약 작업과 별개인 문구 작성이다. 아래 설정에 어긋나지 않는 범위에서 한마디를 창작해도 된다.
- 본인 계정에 본인이 남기는 말이다. 제3자가 이 인물을 설명하는 문장, 직업·종족 요약, 정식 자기소개는 쓰지 않는다.
- 캐릭터가 실제로 쓸 법한 짧은 기분·바람·생각·취향을 말투에 맞게 표현한다. 현재 챗의 사건이나 사용자와의 관계를 새로 지어내지 않는다.
- 이름이나 직책으로 끝나는 소개 문구 대신, 본인이 건네는 한마디로 쓴다. 반드시 '나는/저는'으로 시작할 필요는 없다. 3인칭 자칭 말투도 설정에 있으면 유지한다.
- 한국어로 25자 이내, 한 줄. 영어·설명·라벨 없이 JSON 하나만 출력한다. 키는 status 그대로 쓴다.
{"status":""}

[인물 설정]
${cardText({
					name: contact.name,
					card,
					cardSchema: 2
				})}
[말투 참고 대사]
${(card["대사예시"] || []).slice(0, 2).join("\n")}
[로어 일부]
${lore.slice(0, 1200)}`;
				for (let attempt = 0; attempt < 2; attempt++) {
					try {
						const response = parseCard(await askModel([{
							role: "user",
							content: prompt + (attempt ? "\n직전 결과는 비어 있거나 형식·길이를 충족하지 못했다. 더 짧고 자연스러운 상태메시지 하나를 작성한다." : "")
						}], null, "bio"));
						const bio = profileBio(response?.status ?? response?.["상태메시지"]);
						if (bio) return bio;
					} catch (e) {
						console.log("[interlude] status retry: " + e.message);
					}
				}
				return "";
			})();
			sharedBioJobs.set(key, job);
		}
		try {
			const bio = await job;
			if (!bio) {
				contact.bioError = "상태메시지를 만들지 못했어요. 인물 분석은 유지됩니다. 상태메시지 다시 쓰기를 눌러 주세요.";
				return card;
			}
			contact.bioError = "";
			return {
				...card,
				"한줄소개": bio,
				bioSchema: 1
			};
		} finally {
			if (sharedBioJobs.get(key) === job) sharedBioJobs.delete(key);
		}
	}
	const ensureCardBio = systemInstrument("bio", ensureCardBioRaw, (r, [c]) => ({
		status: c.bioError ? "failed" : "success",
		error: c.bioError
	}));
	async function completeContactBio(contact, lore, options) {
		const card = await ensureCardBio(contact, contact.card, lore, options);
		if (card !== contact.card) {
			applySharedAnalysis(contact, card, lore);
			if (options.botId) await storeSharedAnalysis(sharedAnalysisKey(options.botId, contact, lore), options.botId, contact, lore, card);
		}
	}
	function verifiedSharedCard(card, lore) {
		if (!card || typeof card !== "object" || Array.isArray(card)) return null;
		const verified = verifyCard(card, lore);
		return verified["정체"] || verified["말투"] ? verified : null;
	}
	function applySharedAnalysis(contact, card, lore) {
		contact.card = JSON.parse(JSON.stringify(card));
		contact.cardSchema = 2;
		contact.cardState = "done";
		contact.cardError = "";
		contact.loreHash = loreHash(lore);
		contact.analysisLore = lore;
		contact.analysisStale = false;
		if (!contact.manualBio) contact.bio = profileBio(card["한줄소개"]);
		if (card.bioSchema === 1 && contact.bio) contact.bioError = "";
		if (!contact.role) contact.role = [card["정체"], card["소속"]].filter(Boolean).join(" · ");
	}
	async function storeSharedAnalysisRaw(key, botId, contact, lore, card) {
		try {
			await risuai.pluginStorage.setItem(key, JSON.stringify({
				schema: 2,
				botId,
				person: personKey(contact),
				lore,
				card
			}));
		} catch (e) {
			console.log("[interlude] shared analysis save failed: " + e.message);
			return {
				status: "failed",
				error: e.message
			};
		}
	}
	const storeSharedAnalysis = systemInstrument("storage", storeSharedAnalysisRaw, (r) => r);
	async function reuseAnalysis(contact, lore, options) {
		const { botId } = options;
		if (!botId || !lore) return false;
		const key = sharedAnalysisKey(botId, contact, lore);
		const saved = !options.knownKeys || options.knownKeys.has(key) ? await readJson(key) : null;
		if (saved?.schema === 2 && saved.botId === botId && saved.person === personKey(contact) && saved.lore === lore) {
			const card = verifiedSharedCard(saved.card, lore);
			if (card) {
				applySharedAnalysis(contact, card, lore);
				contact.analysisReused = true;
				return true;
			}
		}
		const validLocal = (c) => c?.cardSchema === 2 && (c.analysisLore === lore || !c.analysisLore && c.loreHash === loreHash(lore)) && verifiedSharedCard(c.card, lore);
		let card = validLocal(contact);
		if (!card) for (const chatKey of (options.chatKeys || []).filter((k) => !options.knownKeys || options.knownKeys.has(k))) {
			if (options.chatStates && !options.chatStates.has(chatKey)) options.chatStates.set(chatKey, readJson(chatKey));
			const other = options.chatStates ? await options.chatStates.get(chatKey) : await readJson(chatKey);
			const match = (Array.isArray(other?.contacts) ? other.contacts : []).find((c) => personKey(c) === personKey(contact) && validLocal(c));
			if (match) {
				card = validLocal(match);
				break;
			}
		}
		if (!card) return false;
		applySharedAnalysis(contact, card, lore);
		contact.analysisReused = true;
		await storeSharedAnalysis(key, botId, contact, lore, card);
		return true;
	}
	async function analyzeContactRaw(contact, books, options = {}) {
		contact.analysisReused = false;
		const usage = [];
		const lore = await memberCardText(contact, books, options.budget?.analysis || LORE_PER_MEMBER, usage, !!options.force);
		contact.contextUsage = usage;
		if (!lore) {
			contact.cardState = "no-lore";
			return false;
		}
		if (!options.force && await reuseAnalysis(contact, lore, options)) {
			await completeContactBio(contact, lore, options);
			return true;
		}
		const key = options.botId ? sharedAnalysisKey(options.botId, contact, lore) : "";
		const jobKey = key + ":" + lore;
		if (key && sharedAnalysisJobs.has(jobKey)) {
			const card = await sharedAnalysisJobs.get(jobKey);
			if (card) {
				applySharedAnalysis(contact, card, lore);
				await completeContactBio(contact, lore, options);
				contact.analysisReused = true;
				return true;
			}
			contact.cardState = "failed";
			return false;
		}
		const task = (async () => {
			if (!options.force && await reuseAnalysis(contact, lore, options)) {
				await completeContactBio(contact, lore, options);
				return contact.card;
			}
			const temporary = { name: contact.name };
			if (!await generateAnalysis(temporary, lore, usage)) {
				contact.cardState = temporary.cardState;
				contact.cardError = temporary.cardError;
				return null;
			}
			const card = await ensureCardBio(contact, temporary.card, lore, options);
			if (key) await storeSharedAnalysis(key, options.botId, contact, lore, card);
			return card;
		})();
		if (key) sharedAnalysisJobs.set(jobKey, task);
		try {
			const card = await task;
			if (!card) return false;
			applySharedAnalysis(contact, card, lore);
			return true;
		} finally {
			if (key && sharedAnalysisJobs.get(jobKey) === task) sharedAnalysisJobs.delete(jobKey);
		}
	}
	const analyzeContact = systemInstrument("analysis", analyzeContactRaw, (r, [c]) => ({
		status: c.cardState === "no-lore" ? "skipped" : !r ? "failed" : c.analysisReused ? "skipped" : c.bioError ? "partial" : "success",
		error: c.cardError || c.bioError
	}));
	function analysisOptions(ctx, force = false) {
		return {
			force,
			botId: ctx.char.chaId,
			budget: contextBudget(states.get(ctx.key)),
			chatStates: new Map(),
			chatKeys: (ctx.char.chats || []).map((chat, i) => STORE_PREFIX + ctx.char.chaId + ":" + (chat.id || "idx" + i))
		};
	}
	async function hydrateSharedAnalysis(ctx, state) {
		if (!state.contacts.length) return;
		const books = await loreBooks(), options = analysisOptions(ctx);
		options.chatStates.set(ctx.key, Promise.resolve(state));
		let changed = false;
		options.knownKeys = new Set(await risuai.pluginStorage.keys() || []);
		options.knownKeys.add(ctx.key);
		const savedTags = imageCfg.enabled ? options.knownKeys : null;
		await inPool(state.contacts, 8, async (contact) => {
			const before = JSON.stringify(contact);
			let applied = false;
			const usage = [];
			const lore = await memberCardText(contact, books, options.budget.analysis, usage);
			contact.contextUsage = usage;
			const matchesSource = contact.analysisLore ? contact.analysisLore === lore : contact.loreHash === loreHash(lore);
			contact.analysisStale = !!contact.card && (!lore || !matchesSource || !verifiedSharedCard(contact.card, lore));
			if (await reuseAnalysis(contact, lore, options)) {
				contact.analysisStale = false;
				applied = true;
			}
			const tagKey = savedTags && !hasImageTags(contact) ? imageTagKey(ctx.char.chaId, contact, lore) : "";
			if (tagKey && savedTags.has(tagKey)) {
				const saved = await readJson(tagKey);
				if (saved?.schema === 1 && saved.lore === lore && saved.tags?.schema === 1) {
					contact.imageTags = saved.tags;
					applied = true;
				}
			}
			if (applied && JSON.stringify(contact) !== before) changed = true;
		});
		if (changed) await saveState(ctx.key);
	}
	async function generateAnalysis(contact, lore, usage = []) {
		const prompt = `아래는 RP 로어북의 인물 "${contact.name}" 항목이다. 메신저 답장에 쓸 인물 카드를 만든다.
규칙:
- 로어에 쓰인 내용만 쓴다. 없으면 빈 값으로 둔다. 추측하지 않는다.
- 설명 문장(정체·말투·관계·직책의 설명 등)은 한국어로 쓴다. 영어 원문을 문장째 복사하지 않는다.
- 인명·학교명·단체명·직책의 고유한 명칭 자체만 로어 표기를 유지한다. 그 명칭을 설명하는 일반 명사·수식어·서술문은 한국어로 쓴다. 예: '게임개발부 member' 대신 '게임개발부 부원'.
- identity(정체)는 신분이나 종족처럼 그 인물이 무엇인지 쓴다.
- 모든 사실 필드에는 evidence(근거)에 로어의 원문을 그대로 인용한다. 번역/요약은 값에, 인용은 evidence에 넣는다. 원문이 영어면 근거도 영어 그대로 쓴다. 근거가 없으면 빈 값이다.
- evidence 객체의 키는 해당 필드 키다. relations(관계)·proper_nouns(고유명사)는 값 배열과 evidence 배열의 같은 위치가 서로 대응해야 한다. 한 근거를 관련 없는 값에 붙이지 않는다. relations의 값은 "대상: 관계" 형식의 문자열이다.
- first_person(1인칭)은 대사에 실제로 나온 표현만 쓴다. 한국어 예시가 없으면 한국어 1인칭을 지어내지 않는다.
- address_rules(호칭관계)는 누구를 부르는지 명시된 경우만 쓴다. target(대상)과 address(호칭)가 quote(원문 인용)에 함께 있어야 한다. 무대 인사/불특정 청중 인사는 상대 호칭이 아니다. 로어의 동료나 가족을 현재 사용자와 동일시하지 않는다.
- 성격을 뒤집어서 금지 규칙을 추론하지 않는다. 추론한 규칙을 생성하지 않는다.
- 프로필 소개 문구는 여기서 생성하지 않는다. 이 작업은 원문 근거가 있는 사실 분석만 수행한다.
JSON 하나만 출력한다. 키는 아래 영어 키를 바꾸지 않고 그대로 쓴다. 값은 위 규칙대로 쓴다(설명은 한국어, 근거는 원문 그대로).
name=이름, identity=정체, affiliation=소속, position=직책, first_person=1인칭, speech=말투, example_lines=대사예시, relations=관계, proper_nouns=고유명사, address_rules=호칭관계, evidence=근거
{"name":"","identity":"","affiliation":"","position":"","first_person":"","speech":"","example_lines":[],"relations":[],"proper_nouns":[],"address_rules":[{"target":"","address":"","quote":""}],"evidence":{"name":"","identity":"","affiliation":"","position":"","first_person":"","speech":"","relations":[],"proper_nouns":[]}}

[로어]
${lore}`;
		let card = null, lastError = "";
		for (let attempt = 0; attempt < 2 && !card; attempt++) {
			try {
				card = parseCard(await askModel([{
					role: "user",
					content: prompt
				}], null, "analysis", usage));
			} catch (e) {
				lastError = e.message;
			}
		}
		if (!card) {
			contact.cardState = "failed";
			contact.cardError = lastError || "모델 응답을 해석하지 못했습니다";
			return false;
		}
		const verified = verifyCard(card, lore);
		if (!verified["정체"] && !verified["말투"]) {
			contact.cardState = "failed";
			contact.cardError = "로어 원문으로 확인할 수 있는 정체·말투가 없어요. 원문을 사용합니다.";
			return false;
		}
		contact.card = verified;
		contact.cardSchema = 2;
		contact.cardState = "done";
		contact.cardError = "";
		contact.loreHash = loreHash(lore);
		if (!contact.manualBio && verified["한줄소개"]) contact.bio = verified["한줄소개"];
		contact.role = [verified["정체"], verified["소속"]].filter(Boolean).join(" · ") || contact.role || "";
		return true;
	}

//#endregion
//#region src/photo/nai.js
	const NAI_MODELS = [
		["nai-diffusion-5-full", "V5 Full"],
		["nai-diffusion-5-curated", "V5 Curated"],
		["nai-diffusion-4-5-full", "V4.5 Full"],
		["nai-diffusion-4-5-curated", "V4.5 Curated"]
	];
	const PHOTO_SIZES = {
		portrait: [
			832,
			1216,
			"세로"
		],
		landscape: [
			1216,
			832,
			"가로"
		],
		square: [
			1024,
			1024,
			"정사각"
		]
	};
	const PHOTO_FREQ = {
		rare: ["드물게", "사진은 드물게 보낸다. 꼭 보여 줄 것이 있거나 부탁받았을 때만 보낸다."],
		normal: ["가끔", "상황에 어울릴 때 가끔 사진을 보낸다."],
		often: ["자주", "어울리면 사진을 자주 보내도 된다."]
	};
	const PHOTO_ASK = {
		easy: ["쉬움 · 부탁하면 항상 보냄", "사용자가 사진을 부탁하면 그 답장에서 반드시 사진을 보낸다. 부탁한 장소·자세·옷을 따르고, 부탁에 없는 부분은 지금 장소와 상황에 맞춘다."],
		normal: ["보통 · 인물이 상황에 따라 판단", "사용자가 사진을 부탁하면 그 인물답게 판단해서 보내거나 거절한다. 사진은 그 인물이 지금 있는 장소와 상황에 맞아야 한다."]
	};
	const DEFAULT_NEGATIVE = "lowres, artistic error, bad anatomy, bad hands, text, watermark, signature";
	let imageCfg = {
		enabled: false,
		model: "nai-diffusion-5-full",
		negative: DEFAULT_NEGATIVE,
		size: "portrait",
		freq: "normal",
		ask: "normal",
		styles: [],
		defaultStyle: "",
		seePhotos: false
	};
	let naiKey = "";
	function setNaiKey(value) {
		naiKey = value;
	}
	async function loadImageCfg() {
		const saved = await readJson(IMAGE_SETTINGS);
		if (saved && typeof saved === "object") imageCfg = {
			...imageCfg,
			...saved
		};
		if (!Array.isArray(imageCfg.styles)) imageCfg.styles = [];
		if (typeof imageCfg.style === "string") {
			if (imageCfg.style.trim() && !imageCfg.styles.length) {
				imageCfg.styles.push({
					id: newId(),
					title: "기본 그림체",
					prompt: imageCfg.style.trim(),
					negative: ""
				});
				imageCfg.defaultStyle = imageCfg.styles[0].id;
			}
			delete imageCfg.style;
			await saveImageCfg();
		}
		naiKey = String(await risuai.getArgument("nai_key") || "").trim();
	}
	function styleFor(state) {
		const styles = imageCfg.styles || [];
		return styles.find((s) => s.id === state?.imageStyle) || styles.find((s) => s.id === imageCfg.defaultStyle) || styles[0] || null;
	}
	const THEMES = [
		["auto", "기기 설정 따르기"],
		["light", "밝게"],
		["dark", "어둡게"]
	];
	let uiCfg = { theme: "auto" };
	function setUiCfg(value) {
		uiCfg = value;
	}
	function applyTheme() {
		if (uiCfg.theme === "light" || uiCfg.theme === "dark") document.documentElement.dataset.theme = uiCfg.theme;
		else delete document.documentElement.dataset.theme;
	}
	async function loadUiCfg() {
		const saved = await readJson(UI_SETTINGS);
		uiCfg = { theme: THEMES.some(([id]) => id === saved?.theme) ? saved.theme : "auto" };
		applyTheme();
	}
	async function saveImageCfgRaw() {
		await risuai.pluginStorage.setItem(IMAGE_SETTINGS, JSON.stringify(imageCfg));
	}
	const saveImageCfg = systemInstrument("storage", saveImageCfgRaw);
	const imageReady = () => !!(imageCfg.enabled && naiKey);
	const modelLabel = (id) => (NAI_MODELS.find((m) => m[0] === id) || [id, id])[1];
	function naiHeaders(json) {
		return {
			Authorization: "Bearer " + naiKey,
			...json ? { "Content-Type": "application/json" } : { Accept: "application/json" }
		};
	}
	function naiError(status, body) {
		if (status === 401 || status === 403) return "NovelAI API 키를 확인해 주세요.";
		if (status === 402) return "NovelAI 구독이나 Anlas가 부족합니다.";
		if (status === 429) return "NovelAI가 다른 그림을 그리는 중입니다. 잠시 뒤 다시 시도해 주세요.";
		return `NovelAI 오류 ${status}${body ? ": " + String(body).slice(0, 120) : ""}`;
	}
	async function naiSuggest(query, model = imageCfg.model) {
		const event = await systemStart("tag-request", { request: `model: ${model}\nquery: ${query}` });
		try {
			const res = await risuai.nativeFetch(`${NAI_SUGGEST}?model=${encodeURIComponent(model)}&prompt=${encodeURIComponent(query)}`, {
				method: "GET",
				headers: naiHeaders(false)
			});
			event.httpStatus = res.status;
			if (!res.ok) throw new Error(naiError(res.status, await res.text().catch(() => "")));
			const data = await res.json();
			event.raw = JSON.stringify(data);
			await systemEnd(event);
			return Array.isArray(data?.tags) ? data.tags.filter((t) => t && typeof t.tag === "string") : [];
		} catch (error) {
			await systemEnd(event, "failed", error);
			throw error;
		}
	}
	const tagForm = (s) => String(s || "").toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
	const wordSet = (s) => tagForm(s).replace(/[()]/g, " ").split(" ").filter(Boolean).sort().join(" ");
	function matchTag(candidate, results) {
		const want = tagForm(candidate);
		if (!want) return null;
		return results.find((r) => tagForm(r.tag) === want) || results.find((r) => wordSet(r.tag) === wordSet(want) && (r.confidence ?? 0) >= .85) || (want.includes(" ") ? results.find((r) => tagForm(r.tag).startsWith(want + " ") && !/[()]/.test(tagForm(r.tag).slice(want.length))) : null) || null;
	}
	function cleanTags(text, max = 400) {
		return String(text || "").replace(/[\r\n]+/g, ", ").replace(/[{}[\]<>|`"\\]/g, "").replace(/_/g, " ").split(",").map((t) => t.trim()).filter(Boolean).join(", ").slice(0, max);
	}
	const COVERING_CHOICES = [
		"covering privates",
		"covering breasts",
		"covering one breast",
		"covering nipples",
		"covering crotch",
		"covering ass",
		"convenient arm",
		"convenient leg",
		"convenient hair",
		"convenient tail",
		"wing censor",
		"hair over breasts",
		"hair over one breast",
		"hair over crotch",
		"crossed arms",
		"arm across chest",
		"arms across body",
		"out-of-frame censoring"
	];
	const NAKED_GARMENTS = [
		"shirt",
		"apron",
		"sweater",
		"ribbon",
		"overalls",
		"hoodie",
		"track jacket",
		"bandage",
		"coat",
		"tabard",
		"cape",
		"jacket",
		"cloak",
		"scarf",
		"robe",
		"kimono",
		"cardigan"
	];
	const NUDE_COVER_ITEMS = [
		[/\btowels?\b/, [
			"naked towel",
			"towel",
			"holding towel"
		]],
		[/\b(?:bed ?)?sheets?\b|\bblankets?\b|\bunder covers\b/, [
			"naked sheet",
			"naked blanket",
			"covering with blanket",
			"under covers"
		]],
		[/\bnude cover\b|\bclothes in front\b|\bcovering with clothes\b/, [
			"nude cover",
			"clothes in front",
			"covering with clothes"
		]],
		...NAKED_GARMENTS.map((item) => [new RegExp(`\\b${item}s?\\b`), [`naked ${item}`]]),
		[/\bpasties\b|\bmaebari\b/, ["pasties", "maebari"]],
		[/\bcensor|\bmosaic\b/, [
			"censored",
			"convenient censoring",
			"mosaic censoring",
			"bar censor",
			"censor bar",
			"novelty censor",
			"heart censor",
			"light censor",
			"soap censor",
			"shadow censor",
			"blur censor",
			"scribble censor"
		]],
		[/\bsteam|\bcensor/, ["steam censor", "convenient bath steam"]]
	];
	function selectedCovering(value) {
		if (!Array.isArray(value)) return [];
		const aliases = {
			covering: "covering privates",
			"nude towel": "naked towel",
			"nude sheet": "naked sheet",
			"hair censor": "convenient hair",
			"folded arms": "crossed arms",
			"arms folded": "crossed arms",
			"cropped censoring": "out-of-frame censoring"
		};
		return [...new Set(value.slice(0, 100).filter((t) => typeof t === "string").map((t) => t.toLowerCase().replace(/_/g, " ").trim()).map((t) => aliases[t] || t).filter((t) => COVERING_CHOICES.includes(t)))];
	}
	function imagePromptTags(base, chars) {
		return [base, ...Array.isArray(chars) ? chars : []].join(", ").split(",").map((t) => t.toLowerCase().replace(/_/g, " ").replace(/[{}\[\]()]/g, "").replace(/[-+]?\d*\.?\d+::|::|:\d*\.?\d+$/g, "").trim());
	}
	function coveringChoicePrompt(base, chars, negative, choices, previouslyAdded = []) {
		const tracked = new Set(selectedCovering(previouslyAdded));
		if (tracked.size) negative = String(negative || "").split(",").filter((t) => !tracked.has(t.trim())).map((t) => t.trim()).filter(Boolean).join(", ");
		const positive = imagePromptTags(base, chars), description = positive.join(", ");
		if (!positive.some((t) => /^(nude|naked)$/.test(t))) return {
			negative,
			avoidCovering: [],
			coveringAdded: []
		};
		const arms = /\b(crossed arms|arm across chest|arms across body|self hug|covering (?:one breast|breasts|nipples))\b/;
		const hair = /\b(convenient hair|hair over (?:one breast|breasts|crotch))\b/;
		const intentional = /\b(covering (?:privates|one breast|breasts|nipples|crotch|ass)|nude cover|naked (?:towel|sheet)|convenient (?:arm|leg|hair|tail|censoring)|(?:wing|steam|soap|light|shadow) censor|out-of-frame censoring)\b/;
		const avoidCovering = selectedCovering(choices).filter((tag) => {
			if (description.includes(tag)) return false;
			if ([
				"crossed arms",
				"arm across chest",
				"arms across body",
				"convenient arm"
			].includes(tag) && arms.test(description)) return false;
			if ([
				"convenient hair",
				"hair over breasts",
				"hair over one breast",
				"hair over crotch"
			].includes(tag) && hair.test(description)) return false;
			if ([
				"covering breasts",
				"covering one breast",
				"covering nipples"
			].includes(tag) && arms.test(description)) return false;
			if (["covering privates", "convenient censoring"].includes(tag) && (intentional.test(description) || arms.test(description) || hair.test(description))) return false;
			if (tag === "nude cover" && /\b(towel|blanket|sheet|pillow|clothes in front)\b/.test(description)) return false;
			if (tag === "naked towel" && /\btowel\b/.test(description)) return false;
			if (tag === "naked sheet" && /\b(sheet|blanket|under covers)\b/.test(description)) return false;
			if (tag === "out-of-frame censoring" && /\b(portrait|upper body|cowboy shot|close-up|close up|headshot)\b/.test(description)) return false;
			return true;
		});
		const existing = new Set(imagePromptTags(negative, []));
		const coveringAdded = avoidCovering.filter((t) => !existing.has(t));
		return {
			negative: [negative, ...coveringAdded].filter(Boolean).join(", "),
			avoidCovering,
			coveringAdded
		};
	}
	const TAG_CHECK_VERSION = 2;
	function seriesForms(tags, names) {
		if (!tags.copyright) return [];
		const latin = (s) => tagForm(s).replace(/\s*\(.*\)\s*$/, "");
		const forms = [];
		for (const c of tags.candidates || []) {
			const words = latin(c).split(" ").filter(Boolean);
			if (!String(c).includes("(") && words.length >= 2) forms.push(words[words.length - 1]);
		}
		for (const n of names || []) {
			const word = latin(n);
			if (/^[a-z][a-z' -]{1,30}$/.test(word)) forms.push(word);
		}
		return forms.map((w) => `${w} (${tags.copyright})`);
	}
	async function checkImageTags(tags, names = []) {
		tags.check = {
			state: "unregistered",
			count: 0,
			model: imageCfg.model,
			at: Date.now(),
			v: TAG_CHECK_VERSION
		};
		tags.character = "";
		tags.copyrightGuess ??= tags.copyright || "";
		try {
			tags.copyright = "";
			if (tags.copyrightGuess) {
				const hit = matchTag(tags.copyrightGuess, await naiSuggest(tags.copyrightGuess));
				if (hit) tags.copyright = tagForm(hit.tag);
			}
			const tries = [...new Set([...(tags.candidates || []).slice(0, 4), ...seriesForms(tags, names)].map(tagForm).filter(Boolean))].slice(0, 10);
			for (const candidate of tries) {
				const hit = matchTag(candidate, await naiSuggest(candidate));
				if (hit) {
					tags.character = tagForm(hit.tag);
					tags.check = {
						...tags.check,
						state: "registered",
						count: Number(hit.count) || 0
					};
					break;
				}
			}
		} catch (e) {
			tags.check = {
				...tags.check,
				state: "error",
				error: e.message
			};
		}
		return tags;
	}
	function personNames(contact, books) {
		const entry = books ? findLoreEntry(contact, books) : null;
		return [
			...contact.aliases || [],
			...contact.keys || [],
			...String(entry?.key || "").split(",")
		].map((s) => String(s).trim()).filter(Boolean);
	}
	const needsRecheck = (tags) => tags.check?.model !== imageCfg.model || tags.check?.state === "error" || tags.check?.state === "unregistered" && (tags.check.v || 1) < TAG_CHECK_VERSION;
	function hasImageTags(contact) {
		return !!(contact?.imageTags?.schema === 1 && (contact.imageTags.character || contact.imageTags.looks || contact.imageTags.outfit));
	}
	function imageTagKey(botId, contact, lore) {
		return IMAGE_TAGS_PREFIX + encodeURIComponent(botId) + ":" + encodeURIComponent(personKey(contact)) + ":" + loreHash(lore);
	}
	async function generateImageTags(contact, lore, botName) {
		const prompt = `인물 "${contact.name}"의 그림을 NovelAI로 그리기 위한 태그를 만든다. 봇 이름: "${botName}".
- character_tags: 이 인물이 기존 작품(애니메이션·게임·만화·소설 등)의 공식 캐릭터라면 Danbooru 캐릭터 태그 후보를 가능성이 높은 순으로 최대 3개 쓴다. 소문자, 밑줄 대신 공백, Danbooru가 쓰는 경우 "(작품)" 한정자를 붙인다. 예: "saber (fate)", "takanashi hoshino". 이름 순서가 다른 표기도 후보가 될 수 있다. 이 봇만의 창작 인물이거나 확실하지 않으면 빈 배열이다.
- copyright: 그 작품의 Danbooru 작품 태그. 예: "blue archive". 모르면 빈 문자열.
- gender: girl, boy, other 중 하나.
- looks: 바뀌지 않는 외형을 영어 Danbooru 태그로 쉼표로 나눠 쓴다. 머리색, 머리 길이와 모양, 눈색, 체형, 늘 달고 있는 장신구(헤일로, 머리장식 등). 옷과 신발은 쓰지 않는다.
- outfit: 평소 옷차림을 영어 Danbooru 태그로 쉼표로 나눠 쓴다. 옷, 신발, 모자. 최대 15개. 로어에 쓰인 외형을 우선하고, 로어에 없으면 공식 캐릭터일 때만 널리 알려진 기본 외형으로 채운다. 표정, 자세, 배경, 이름은 쓰지 않는다. 최대 25개.
JSON 하나만 출력한다: {"character_tags":[],"copyright":"","gender":"girl","age":"unknown","looks":"","outfit":""}

[로어]
${lore || "(로어 항목 없음)"}`;
		let raw = null, lastError = "";
		for (let attempt = 0; attempt < 2 && !raw; attempt++) {
			try {
				raw = parseCard(await askModel([{
					role: "user",
					content: prompt
				}], null, "image-tags"));
			} catch (e) {
				lastError = e.message;
			}
		}
		if (!raw) throw new Error(lastError || "사진 태그 응답을 해석하지 못했습니다");
		const candidates = (Array.isArray(raw.character_tags) ? raw.character_tags : []).map(tagForm).filter((t) => t && t.length <= 80).slice(0, 3);
		return {
			schema: 1,
			candidates,
			character: "",
			copyright: tagForm(raw.copyright).slice(0, 80),
			gender: [
				"girl",
				"boy",
				"other"
			].includes(raw.gender) ? raw.gender : "girl",
			...splitOutfit(raw.looks, raw.outfit),
			manual: false
		};
	}
	async function ensureImageTags(contact, ctx, books, options = {}) {
		const lore = await memberLoreText(contact, books, contextBudget(states.get(ctx.key)).analysis);
		const key = imageTagKey(ctx.char.chaId, contact, lore);
		if (!options.force) {
			let tags = contact.imageTags?.schema === 1 && (contact.imageTags.manual || contact.imageTags.loreHash === loreHash(lore)) ? contact.imageTags : null;
			if (!tags) {
				const saved = await readJson(key);
				if (saved?.schema === 1 && saved.lore === lore && saved.tags?.schema === 1) tags = saved.tags;
			}
			if (tags) {
				if (needsRecheck(tags)) await checkImageTags(tags, personNames(contact, books));
				contact.imageTags = tags;
				return tags;
			}
		}
		const tags = await checkImageTags(await generateImageTags(contact, lore, ctx.char.name), personNames(contact, books));
		tags.loreHash = loreHash(lore);
		contact.imageTags = tags;
		await storeImageTags(ctx.char.chaId, contact, lore, tags);
		return tags;
	}
	async function storeImageTagsRaw(botId, contact, lore, tags) {
		try {
			await risuai.pluginStorage.setItem(imageTagKey(botId, contact, lore), JSON.stringify({
				schema: 1,
				lore,
				tags
			}));
		} catch (e) {
			console.log("[interlude] image tags save failed: " + e.message);
			return {
				status: "failed",
				error: e.message
			};
		}
	}
	const storeImageTags = systemInstrument("storage", storeImageTagsRaw, (r) => r);
	const CLOTHING_RE = /\b(uniform|dress|shirt|blouse|skirt|jacket|coat|hoodie|sweater|cardigan|vest|kimono|yukata|hakama|swimsuit|bikini|apron|pajamas|leotard|bodysuit|shorts|pants|jeans|trousers|overalls|armor|cape|cloak|robe|gown|qipao|serafuku|necktie|bowtie|neckerchief|gloves|thighhighs|kneehighs|pantyhose|stockings|socks|shoes|boots|sandals|heels|loafers|sneakers|footwear|legwear|scarf|sleeves|sleeveless|collar|belt|suit|tuxedo|outfit|costume|clothes|underwear|bra|panties|lingerie|maid|leggings|tank top|crop top|camisole|turtleneck|hat|beret|headwear|nude|naked)\b/;
	const isClothing = (tag) => (CLOTHING_RE.test(tag) || /\b(?:gold|silver) trim\b/.test(tag)) && !/^hair\b|\bhair (ornament|ribbon|bow|flower|clip|band|tie)\b/.test(tag);
	function splitOutfit(looks, outfit) {
		const all = cleanTags(looks, 600).split(", ").filter(Boolean);
		const worn = cleanTags(outfit, 400).split(", ").filter(Boolean);
		return {
			looks: all.filter((t) => !isClothing(t)).join(", "),
			outfit: [...new Set([...worn, ...all.filter(isClothing)])].join(", ").slice(0, 400)
		};
	}
	const tagParts = (t) => splitOutfit(t?.looks, t?.outfit || "");
	function coveringNegative(base, chars, negative) {
		return coveringAuto(base, chars, negative).negative;
	}
	function coveringAuto(base, chars, negative) {
		const normalizeTag = (t) => t.toLowerCase().replace(/_/g, " ").replace(/[{}\[\]()]/g, "").replace(/\d*\.?\d+::|::|:\d*\.?\d+$/g, "").trim();
		const positive = [base, ...chars].join(", ").split(",").map(normalizeTag);
		if (!positive.some((t) => /^(nude|naked)$/.test(t))) return {
			negative,
			added: []
		};
		const description = positive.join(", ");
		const families = [
			[/\b(towels?|towelling|toweling)\b/, ["towel", "bath towel"]],
			[/\b(bathrobes?|robes?|dressing gown)\b|\bbath robe\b/, ["robe", "bathrobe"]],
			[/\bblankets?\b|\bunder covers\b/, ["blanket"]],
			[/\b(?:bed ?)?sheets?\b|\bunder covers\b/, ["sheet"]],
			[/\b(underwear|lingerie|bra|panties|underpants|boxers|briefs)\b/, ["underwear"]]
		];
		const additions = [...families, ...NUDE_COVER_ITEMS].filter(([pattern]) => !pattern.test(description)).flatMap(([, tags]) => tags);
		if (!positive.some((t) => isClothing(t) && !/^(nude|naked)$/.test(t)) && !families.some(([pattern]) => pattern.test(description)) && !/\b(cloth|fabric|clothing|garments?)\b/.test(description)) additions.push("clothes", "cloth");
		const existing = new Set(String(negative || "").split(",").map(normalizeTag));
		const added = additions.filter((t) => !existing.has(t));
		return {
			negative: [negative, ...added].filter(Boolean).join(", "),
			added
		};
	}
	const NUDITY_RE = /^(?:nude|naked|completely nude|full nude|topless|bottomless)$/;
	const FULL_NUDE_RE = /^(?:nude|naked|completely nude|full nude)$/;
	const NUDE_COVERS = [
		[/\b(swimsuits?|bikinis?)\b/, ["swimsuit", "bikini"]],
		[/\b(underwear|lingerie|bra|panties)\b/, [
			"underwear",
			"bra",
			"panties"
		]],
		[/\b(towels?)\b/, ["towel"]],
		[/\b(blankets?|(?:bed ?)?sheets?|under covers)\b/, ["blanket", "bed sheet"]],
		[/\b(censor|censored|censoring|mosaic)\b/, [
			"censored",
			"mosaic censoring",
			"bar censor"
		]]
	];
	const tagList = (text) => String(text || "").split(",").map((t) => t.trim()).filter(Boolean);
	const stripNudity = (text) => tagList(text).filter((t) => !NUDITY_RE.test(t.toLowerCase())).join(", ");
	function nudeCoverNegative(description) {
		const words = String(description || "").toLowerCase();
		const clothed = tagList(words).some((t) => isClothing(t) && !NUDITY_RE.test(t));
		return [...clothed ? [] : ["clothes"], ...NUDE_COVERS.filter(([pattern]) => !pattern.test(words)).flatMap(([, tags]) => tags)].join(", ");
	}
	const OTHER_PEOPLE_RE = /^(?:solo|solo focus|\d+\+?(?:girl|boy|other)s?|multiple (?:girls|boys|others|people)|crowd|people|group|everyone|hetero|yuri|yaoi|other (?:girls?|boys?|people)|faceless (?:male|female)|background (?:people|crowd)|(?:people|person|crowd|man|men|woman|women|girls?|boys?) in (?:the )?background)$/;
	function photoPrompt(people, sceneTags, style, outfits = {}, r18 = false, omitLooks = {}, avoidCovering = []) {
		const counts = {
			girl: 0,
			boy: 0,
			other: 0
		};
		for (const p of people) counts[p.imageTags?.gender || "girl"]++;
		const countTags = people.length ? [
			counts.girl ? counts.girl === 1 ? "1girl" : `${counts.girl}girls` : "",
			counts.boy ? counts.boy === 1 ? "1boy" : `${counts.boy}boys` : "",
			counts.other ? counts.other === 1 ? "1other" : `${counts.other}others` : ""
		].filter(Boolean).join(", ") : "no humans";
		const scene = people.length && !r18 ? cleanTags(sceneTags).split(", ").filter((t) => t && !isClothing(t)) : cleanTags(sceneTags).split(", ").filter(Boolean);
		const worn = { ...outfits };
		const sceneAttire = r18 && people.length && scene.some(isClothing);
		const sceneNude = scene.some((t) => FULL_NUDE_RE.test(t.toLowerCase()));
		const nudes = [];
		const solo = people.length === 1 && !scene.some((t) => OTHER_PEOPLE_RE.test(t.toLowerCase().replace(/_/g, " ")));
		const base = [
			countTags,
			solo ? "solo" : "",
			cleanTags(style?.prompt, 1500),
			scene.join(", ")
		].filter(Boolean).join(", ");
		const chars = people.map((p) => {
			const t = p.imageTags || {};
			const parts = tagParts(t);
			const omitted = new Set((Array.isArray(omitLooks[p.id]) ? omitLooks[p.id] : []).filter((v) => typeof v === "string").map((v) => cleanTags(v)));
			const looks = parts.looks.split(", ").filter((tag) => !omitted.has(tag)).join(", ");
			const registered = t.check?.state === "registered" && t.character;
			const wearing = cleanTags(worn[p.id]);
			const nude = sceneNude || tagList(wearing).some((tag) => FULL_NUDE_RE.test(tag.toLowerCase()));
			nudes.push(nude);
			return [
				t.gender || "girl",
				registered ? t.character : "",
				registered && t.copyright ? t.copyright : "",
				looks,
				wearing || (sceneAttire ? "" : parts.outfit),
				nude && !/\bcompletely nude\b/.test(wearing) ? "completely nude" : ""
			].filter(Boolean).join(", ");
		});
		const charNegatives = chars.map((caption, i) => nudes[i] ? nudeCoverNegative([base, caption].join(", ")) : "");
		const negative = [cleanTags(imageCfg.negative, 1500), cleanTags(style?.negative, 1500)].filter(Boolean).join(", ");
		const auto = coveringAuto(base, chars, negative);
		const choice = coveringChoicePrompt(base, chars, auto.negative, avoidCovering);
		return {
			base,
			chars,
			negative: choice.negative,
			...charNegatives.some(Boolean) ? { charNegatives } : {},
			...auto.added.length ? { autoCovering: auto.added } : {},
			...choice.avoidCovering.length ? { avoidCovering: choice.avoidCovering } : {},
			...choice.coveringAdded.length ? { coveringAdded: choice.coveringAdded } : {}
		};
	}
	let naiChain = Promise.resolve();
	function naiGenerate(prompt, size, onRequest, options = {}) {
		const run = naiChain.then(() => naiGenerateNow(prompt, size, onRequest, options));
		naiChain = run.catch(() => {});
		return run;
	}
	async function naiGenerateNow({ base, chars, negative, charNegatives = [], avoidCovering = [], coveringAdded = [], autoCovering = [], edited = false }, size, onRequest, options = {}) {
		let choice = {
			avoidCovering,
			coveringAdded
		};
		if (!edited) {
			const auto = coveringAuto(base, chars, negative);
			autoCovering = [...new Set([...autoCovering, ...auto.added])];
			choice = coveringChoicePrompt(base, chars, auto.negative, avoidCovering, coveringAdded);
			negative = choice.negative;
		}
		const [width, height] = size || PHOTO_SIZES[imageCfg.size] || PHOTO_SIZES.portrait;
		const model = options.model || imageCfg.model;
		const center = [{
			x: .5,
			y: .5
		}];
		const parameters = {
			params_version: 3,
			width,
			height,
			scale: 6,
			sampler: "k_euler_ancestral",
			steps: 28,
			n_samples: 1,
			ucPreset: 0,
			qualityToggle: true,
			noise_schedule: "karras",
			cfg_rescale: .5,
			negative_prompt: negative,
			seed: Math.floor(Math.random() * 4294967295),
			dynamic_thresholding: false,
			legacy: false,
			add_original_image: false,
			prefer_brownian: true,
			deliberate_euler_ancestral_bug: false,
			use_coords: false,
			v4_prompt: {
				caption: {
					base_caption: base,
					char_captions: chars.map((c) => ({
						char_caption: c,
						centers: center
					}))
				},
				use_coords: false,
				use_order: true
			},
			v4_negative_prompt: {
				caption: {
					base_caption: negative,
					char_captions: chars.map((_, i) => ({
						char_caption: String(charNegatives[i] || ""),
						centers: center
					}))
				},
				legacy_uc: false
			}
		};
		if (model.includes("4-5")) parameters.skip_cfg_above_sigma = 59.04722600415217;
		const body = JSON.stringify({
			input: base,
			model,
			action: "generate",
			parameters
		});
		onRequest?.({
			schema: 1,
			base,
			chars: [...chars],
			negative,
			...charNegatives.some(Boolean) ? { charNegatives: chars.map((_, i) => String(charNegatives[i] || "")) } : {},
			model,
			width,
			height,
			seed: parameters.seed,
			...autoCovering.length ? { autoCovering } : {},
			...choice.avoidCovering.length ? { avoidCovering: choice.avoidCovering } : {},
			...choice.coveringAdded.length ? { coveringAdded: choice.coveringAdded } : {}
		});
		for (let attempt = 0;; attempt++) {
			const event = await systemStart("image-request", {
				request: body,
				attempt: attempt + 1
			});
			try {
				const res = await risuai.nativeFetch(NAI_ENDPOINT, {
					method: "POST",
					headers: naiHeaders(true),
					body
				});
				event.httpStatus = res.status;
				if (res.status === 429 && attempt < 3) {
					await systemEnd(event, "failed", "HTTP 429: 재시도 예정");
					await sleep(4e3);
					continue;
				}
				if (!res.ok) throw new Error(naiError(res.status, await res.text().catch(() => "")));
				const bytes = new Uint8Array(await res.arrayBuffer());
				const image = await unzipFirstImage(bytes);
				event.raw = `이미지 응답 ${bytes.length} bytes (이미지 본문 미수집)`;
				await systemEnd(event);
				return image;
			} catch (error) {
				await systemEnd(event, "failed", error);
				throw error;
			}
		}
	}
	async function unzipFirstImage(buf) {
		const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		if (buf[0] === 137 && buf[1] === 80) return buf;
		let end = -1;
		for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 101010256) {
			end = i;
			break;
		}
		if (end < 0) throw new Error("NovelAI 응답에서 그림을 찾지 못했습니다");
		let p = dv.getUint32(end + 16, true);
		for (let n = dv.getUint16(end + 10, true); n > 0; n--) {
			if (dv.getUint32(p, true) !== 33639248) break;
			const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), nameLen = dv.getUint16(p + 28, true);
			const local = dv.getUint32(p + 42, true), name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
			p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
			if (!/\.(png|webp|jpe?g)$/i.test(name)) continue;
			const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
			const data = buf.subarray(start, start + size);
			if (method === 0) return data;
			return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
		}
		throw new Error("NovelAI 응답에서 그림을 찾지 못했습니다");
	}
	async function encodeImage(bytes, maxWidth, quality) {
		const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		const scale = Math.min(1, maxWidth / bitmap.width);
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(bitmap.width * scale);
		canvas.height = Math.round(bitmap.height * scale);
		canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		bitmap.close?.();
		return {
			url: canvas.toDataURL("image/webp", quality),
			w: canvas.width,
			h: canvas.height
		};
	}
	const thumbUrls = new Map();
	async function photoThumb(id) {
		if (thumbUrls.has(id)) {
			const url = thumbUrls.get(id);
			thumbUrls.delete(id);
			thumbUrls.set(id, url);
			return url;
		}
		const url = await risuai.pluginStorage.getItem(PHOTO_PREFIX + "thumb:" + id);
		if (typeof url !== "string") return "";
		thumbUrls.set(id, url);
		if (thumbUrls.size > THUMB_CACHE) thumbUrls.delete(thumbUrls.keys().next().value);
		return url;
	}
	async function photoFull(id) {
		const url = await risuai.pluginStorage.getItem(PHOTO_PREFIX + "full:" + id);
		return typeof url === "string" ? url : "";
	}
	async function deletePhotoData(id) {
		if (!id) return;
		thumbUrls.delete(id);
		await risuai.pluginStorage.removeItem(PHOTO_PREFIX + "thumb:" + id);
		await risuai.pluginStorage.removeItem(PHOTO_PREFIX + "full:" + id);
	}
	const photoQueue = [];
	let photoRunning = false;
	function queuePhoto(key, roomId, msgId) {
		let job = photoQueue.find((j) => j.key === key && j.msgId === msgId);
		if (!job) {
			job = {
				key,
				roomId,
				msgId
			};
			job.done = new Promise((resolve) => {
				job.resolve = resolve;
			});
			photoQueue.push(job);
		}
		runPhotoQueue();
		return job.done;
	}
	async function runPhotoQueue() {
		if (photoRunning) return;
		photoRunning = true;
		try {
			while (photoQueue.length) {
				const job = photoQueue.shift();
				try {
					await makePhoto(job);
				} finally {
					job.resolve?.();
				}
			}
		} finally {
			photoRunning = false;
		}
	}
	function photoPerson(state, id) {
		if (id === "me") return {
			id: "me",
			name: view.me?.name || "나",
			imageTags: state.meImageTags || {
				schema: 1,
				character: "",
				copyright: "",
				gender: "girl",
				looks: "",
				outfit: ""
			}
		};
		return state.contacts.find((c) => c.id === id);
	}
	async function makePhoto({ key, roomId, msgId }) {
		const state = states.get(key);
		const room = state?.rooms.find((r) => r.id === roomId);
		const msg = room?.msgs.find((m) => m.id === msgId);
		if (!msg?.photo) return;
		Object.assign(msg.photo, {
			state: "pending",
			error: ""
		});
		render();
		try {
			const people = (msg.photo.who || []).map((id) => photoPerson(state, id)).filter(Boolean);
			const shot = await drawAndStore(key, state, people, msg.photo.tags, undefined, msg.photo.outfit, msg.photo.r18 === true, msg.photo.omitLooks, msg.photo.promptOverride || msg.photo.generation, msg.photo.avoidCovering);
			const old = msg.photo.id;
			Object.assign(msg.photo, {
				...shot,
				state: "done",
				error: "",
				made: Date.now()
			});
			if (old) await deletePhotoData(old);
		} catch (e) {
			Object.assign(msg.photo, {
				state: "failed",
				error: e.message
			});
		}
		await saveState(key);
		render();
	}
	async function drawAndStoreRaw(key, state, people, sceneTags, size, outfits, r18 = false, omitLooks = {}, promptOverride = null, avoidCovering = [], extraNegative = "") {
		if (!imageReady()) throw new Error("설정 → 사진에서 사진 기능을, 설정 → 시작 준비에서 NovelAI 키를 확인해 주세요.");
		const missing = promptOverride ? [] : people.filter((p) => p.id !== "me" && !hasImageTags(p));
		if (missing.length) {
			const ctx = view.ctx?.key === key ? view.ctx : await getContext();
			if (ctx?.key === key) {
				const books = await loreBooks();
				for (const p of missing) await ensureImageTags(p, ctx, books);
			}
		}
		const style = promptOverride ? null : styleFor(state);
		const prompt = promptOverride ? {
			edited: !!promptOverride.edited,
			...promptOverride.autoCovering?.length ? { autoCovering: promptOverride.autoCovering } : {},
			base: promptOverride.base,
			chars: [...promptOverride.chars],
			negative: promptOverride.negative,
			...Array.isArray(promptOverride.charNegatives) ? { charNegatives: [...promptOverride.charNegatives] } : {},
			...promptOverride.avoidCovering?.length ? { avoidCovering: promptOverride.avoidCovering } : {},
			...promptOverride.coveringAdded?.length ? { coveringAdded: promptOverride.coveringAdded } : {}
		} : photoPrompt(people, sceneTags, style, outfits, r18, omitLooks, avoidCovering);
		if (promptOverride) {
			size = [promptOverride.width, promptOverride.height];
			if (Array.isArray(promptOverride.charNegatives)) prompt.charNegatives = [...promptOverride.charNegatives];
		} else if (extraNegative) {
			const has = new Set(tagList(prompt.negative).map((t) => t.toLowerCase()));
			prompt.negative = [prompt.negative, ...tagList(extraNegative).filter((t) => !has.has(t.toLowerCase()))].filter(Boolean).join(", ");
		}
		let generation;
		const png = await naiGenerate(prompt, size, (request) => {
			generation = {
				...request,
				people: people.map((p) => ({
					id: p.id,
					name: p.name
				}))
			};
		}, promptOverride ? { model: promptOverride.model } : {});
		const full = await encodeImage(png, 4096, .9);
		const thumb = await encodeImage(png, THUMB_WIDTH, .78);
		const id = newId();
		await risuai.pluginStorage.setItem(PHOTO_PREFIX + "full:" + id, full.url);
		await risuai.pluginStorage.setItem(PHOTO_PREFIX + "thumb:" + id, thumb.url);
		thumbUrls.set(id, thumb.url);
		return {
			id,
			w: full.w,
			h: full.h,
			model: generation?.model || imageCfg.model,
			style: style?.title || "",
			generation
		};
	}
	const drawAndStore = systemInstrument("photo", drawAndStoreRaw);
	const PROFILE_TAGS = "portrait, upper body, looking at viewer, smile, simple background";
	const PROFILE_NEGATIVE = "multiple views, character sheet, reference sheet, multiple girls, multiple boys, 2girls, 2boys, split screen, zoom layer";
	async function drawProfile(key, state, contact) {
		const shot = await drawAndStore(key, state, [contact], PROFILE_TAGS, PHOTO_SIZES.square, undefined, false, {}, null, [], PROFILE_NEGATIVE);
		contact.profileShots = [...contact.profileShots || [], {
			...shot,
			t: Date.now()
		}];
		contact.image = await avatarFrom(await photoFull(shot.id), true);
		contact.manualImage = true;
		await saveState(key);
	}
	const AVATAR_SIZE = 512;
	async function avatarFrom(url, square) {
		const img = await decodeImage(url);
		const { sx, sy, side } = avatarRect(img.naturalWidth, img.naturalHeight, square);
		return squareImage(img, sx, sy, side, AVATAR_SIZE, .92);
	}
	function avatarRect(W, H, square) {
		const side = square ? Math.min(W, H) : Math.round(Math.min(W, H) * .75);
		return {
			side,
			sx: Math.round((W - side) / 2),
			sy: square ? Math.round((H - side) / 2) : Math.round(Math.min(H - side, H * .06))
		};
	}
	async function decodeImage(url) {
		const img = new Image();
		img.src = url;
		await img.decode();
		return img;
	}
	function squareImage(img, sx, sy, side, size, quality) {
		let src = img, x = sx, y = sy, s = side;
		while (s / 2 >= size) {
			const step = document.createElement("canvas");
			step.width = step.height = Math.round(s / 2);
			const g = step.getContext("2d");
			g.imageSmoothingQuality = "high";
			g.drawImage(src, x, y, s, s, 0, 0, step.width, step.height);
			src = step;
			x = y = 0;
			s = step.width;
		}
		const out = document.createElement("canvas");
		out.width = out.height = size;
		const g = out.getContext("2d");
		g.imageSmoothingQuality = "high";
		g.drawImage(src, x, y, s, s, 0, 0, size, size);
		return out.toDataURL("image/webp", quality);
	}
	const OLD_AVATAR = 256;
	function printOf(img, sx, sy, side) {
		const c = document.createElement("canvas");
		c.width = c.height = 16;
		const g = c.getContext("2d", { willReadFrequently: true });
		g.imageSmoothingQuality = "high";
		g.drawImage(img, sx, sy, side, side, 0, 0, 16, 16);
		const px = g.getImageData(0, 0, 16, 16).data, out = [];
		for (let i = 0; i < px.length; i += 4) out.push(px[i], px[i + 1], px[i + 2]);
		return out;
	}
	const printDiff = (a, b) => a.reduce((n, v, i) => n + Math.abs(v - b[i]), 0) / a.length;
	async function upgradeDrawnAvatars(key, state) {
		let changed = 0, failed = false;
		for (const c of state.contacts || []) {
			const shots = (c.profileShots || []).filter((s) => s.id);
			if (!shots.length || typeof c.image !== "string" || !c.image.startsWith("data:image/")) continue;
			try {
				const old = await decodeImage(c.image);
				if (old.naturalWidth !== OLD_AVATAR || old.naturalHeight !== OLD_AVATAR) continue;
				const mine = printOf(old, 0, 0, OLD_AVATAR);
				let best = null;
				for (const shot of shots.slice().reverse()) {
					const full = await photoFull(shot.id);
					if (!full) continue;
					const img = await decodeImage(full);
					const { sx, sy, side } = avatarRect(img.naturalWidth, img.naturalHeight, true);
					const diff = printDiff(mine, printOf(img, sx, sy, side));
					if (!best || diff < best.diff) best = {
						diff,
						img,
						sx,
						sy,
						side
					};
				}
				if (!best || best.diff > 6) continue;
				const image = squareImage(best.img, best.sx, best.sy, best.side, AVATAR_SIZE, .92);
				if (!state.contacts.includes(c) || c.image !== old.src) continue;
				const crop = validImageCrop(c.imageCrop, c.image) ? {
					...c.imageCrop,
					source: image
				} : c.imageCrop;
				Object.assign(c, {
					image,
					...crop ? { imageCrop: crop } : {}
				});
				changed++;
			} catch (e) {
				failed = true;
				console.log("[interlude] profile upgrade failed: " + e.message);
			}
		}
		if (!failed) state.avatarsChecked = 1;
		if (changed || !failed) {
			try {
				await saveState(key);
			} catch (e) {
				console.log("[interlude] profile upgrade save failed: " + e.message);
			}
		}
		if (changed && view.key === key) render();
		return changed;
	}
	function photosOf(state, contactId = "") {
		const out = [];
		for (const room of state.rooms) for (const m of room.msgs) {
			if (m.photo?.state !== "done" || !m.photo.id) continue;
			if (contactId && m.from !== contactId && !(m.photo.who || []).includes(contactId)) continue;
			out.push({
				room,
				msg: m
			});
		}
		for (const c of state.contacts) {
			if (contactId && c.id !== contactId) continue;
			for (const s of c.profileShots || []) out.push({
				room: null,
				profileOf: c,
				msg: {
					id: s.id,
					from: c.id,
					t: s.t,
					text: "",
					photo: {
						...s,
						state: "done",
						who: [c.id]
					}
				}
			});
		}
		return out.sort((a, b) => b.msg.t - a.msg.t);
	}
	const photoOutfit = (p) => Object.values(p.outfit || {}).filter(Boolean).join(" / ");
	const photoLine = (m) => m.photo ? `[사진${m.photo.desc ? ": " + m.photo.desc : ""}${photoOutfit(m.photo) ? " · 옷: " + photoOutfit(m.photo) : ""}]${m.text ? " " + m.text : ""}` : m.text;

//#endregion
//#region src/core/bot-config.js
	const BOT_PREFIX = "interlude:bot:v1:";
	const BOT_CARDS = {
		flow: {
			label: "대화 흐름",
			fields: ["mode"]
		},
		link: {
			label: "본편과 메신저",
			fields: ["storyIn", "inject"]
		},
		memory: {
			label: "메모리",
			fields: [
				"newMemory",
				"useSummary",
				"storySource",
				"memoryOn"
			]
		},
		time: {
			label: "시간 반영",
			fields: ["timeMode", "timeSource"]
		},
		budget: {
			label: "설정 분량",
			fields: ["contextBudget"]
		},
		style: {
			label: "그림체",
			fields: ["imageStyle"]
		},
		polish: {
			label: "말투로 다듬기",
			fields: ["polish"]
		}
	};
	const BOT_DEFAULTS = {
		mode: "balanced",
		storyIn: true,
		inject: true,
		newMemory: true,
		useSummary: true,
		storySource: "auto",
		memoryOn: true,
		contextBudget: {
			mode: "standard",
			...CONTEXT_PRESETS.standard
		},
		imageStyle: "",
		timeMode: "off",
		timeSource: { kind: "auto" },
		polish: true
	};
	const CHAT_DEFAULTS = {
		...BOT_DEFAULTS,
		newMemory: false,
		memoryOn: false
	};
	const BOT_FIELD_LABELS = {
		mode: "흐름",
		storyIn: "본편 → 메신저",
		inject: "메신저 → 본편",
		newMemory: "새 메모리 사용",
		useSummary: "본편 메모리 사용",
		storySource: "가져올 곳",
		memoryOn: "메모리 자동 정리",
		contextBudget: "분량",
		imageStyle: "그림체",
		timeMode: "모드",
		timeSource: "시간 출처",
		polish: "캐릭터 계정에서 말투로 다듬기"
	};
	const botCfgs = new Map();
	const copyValue = (v) => v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v;
	const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
	const botIdOf = (key) => key.slice(STORE_PREFIX.length).split(":")[0];
	const follows = (state, card) => state?.follow?.[card] === true;
	const chatValue = (state, field) => field === "contextBudget" ? contextBudget(state) : state?.[field] ?? CHAT_DEFAULTS[field];
	const AUTO_MEMORY_KEY = "interlude:auto-memory:v1";
	let autoMemoryRecord = null;
	let autoMemoryRecordLoad = null;
	function loadAutoMemoryRecord() {
		return autoMemoryRecordLoad ||= (async () => {
			const raw = await risuai.pluginStorage.getItem(AUTO_MEMORY_KEY);
			const saved = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (saved?.schema === 1 && typeof saved.answered === "boolean" && Array.isArray(saved.legacyBots)) return autoMemoryRecord = saved;
			const keys = await risuai.pluginStorage.keys() || [];
			const legacyBots = [...new Set(keys.flatMap((k) => k.startsWith(STORE_PREFIX) ? [botIdOf(k)] : k.startsWith(BOT_PREFIX) ? [k.slice(BOT_PREFIX.length)] : []))];
			const record = {
				schema: 1,
				answered: !legacyBots.length,
				legacyBots
			};
			await risuai.pluginStorage.setItem(AUTO_MEMORY_KEY, JSON.stringify(record));
			return autoMemoryRecord = record;
		})().catch((e) => {
			autoMemoryRecordLoad = null;
			console.log("[interlude] memory choice load failed: " + e.message);
			return null;
		});
	}
	async function saveAutoMemoryRecord(record) {
		await risuai.pluginStorage.setItem(AUTO_MEMORY_KEY, JSON.stringify(record));
		autoMemoryRecord = record;
		autoMemoryRecordLoad = Promise.resolve(record);
	}
	const BUDGET_KEY = "interlude:budget:v1";
	let budgetRecordLoad = null;
	function setBudgetRecordLoad(value) {
		budgetRecordLoad = value;
	}
	function loadBudgetRecord() {
		return budgetRecordLoad ||= (async () => {
			const raw = await risuai.pluginStorage.getItem(BUDGET_KEY);
			const saved = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (saved && typeof saved === "object") return saved;
			const keys = await risuai.pluginStorage.keys() || [];
			const record = {
				schema: 1,
				legacy: keys.some((k) => k.startsWith(STORE_PREFIX) || k.startsWith(BOT_PREFIX))
			};
			try {
				await risuai.pluginStorage.setItem(BUDGET_KEY, JSON.stringify(record));
			} catch (e) {
				console.log("[interlude] budget record save failed: " + e.message);
			}
			return record;
		})().catch((e) => {
			console.log("[interlude] budget record load failed: " + e.message);
			budgetRecordLoad = null;
			return {
				schema: 1,
				legacy: true
			};
		});
	}
	function budgetDefault(record) {
		if (Object.hasOwn(CONTEXT_PRESETS, record?.mode || "")) return {
			mode: record.mode,
			...CONTEXT_PRESETS[record.mode]
		};
		return record?.legacy ? LEGACY_LIGHT() : copyValue(BOT_DEFAULTS.contextBudget);
	}
	async function loadBotCfg(botId) {
		const memoryRecord = await loadAutoMemoryRecord();
		if (botCfgs.has(botId)) return botCfgs.get(botId);
		const saved = await readJson(BOT_PREFIX + botId);
		const cfg = copyValue(BOT_DEFAULTS);
		if (saved && typeof saved === "object") {
			for (const field of Object.keys(BOT_DEFAULTS)) if (saved[field] !== undefined) cfg[field] = copyValue(saved[field]);
		}
		if (saved?.memoryOn === undefined && (!memoryRecord || memoryRecord.legacyBots.includes(botId))) cfg.memoryOn = false;
		if (!saved || typeof saved !== "object" || saved.contextBudget === undefined) cfg.contextBudget = budgetDefault(await loadBudgetRecord());
		try {
			cfg.contextBudget = validateContextBudget(cfg.contextBudget);
		} catch {
			cfg.contextBudget = copyValue(BOT_DEFAULTS.contextBudget);
		}
		if (!Object.hasOwn(TIME_MODES, cfg.timeMode)) cfg.timeMode = "off";
		if (!cfg.timeSource || typeof cfg.timeSource !== "object" || !TIME_SOURCES.some(([id]) => id === cfg.timeSource.kind)) cfg.timeSource = { kind: "auto" };
		botCfgs.set(botId, cfg);
		return cfg;
	}
	function applyBotCfg(state, cfg) {
		let changed = false;
		for (const [card, { fields }] of Object.entries(BOT_CARDS)) {
			if (!follows(state, card)) continue;
			for (const field of fields) if (!sameValue(state[field], cfg[field])) {
				state[field] = copyValue(cfg[field]);
				changed = true;
			}
		}
		return changed;
	}
	async function saveBotCfg(botId, cfg) {
		await risuai.pluginStorage.setItem(BOT_PREFIX + botId, JSON.stringify({
			schema: 1,
			...cfg
		}));
		botCfgs.set(botId, cfg);
		for (const [key, state] of states) if (botIdOf(key) === botId && applyBotCfg(state, cfg)) await saveState(key);
	}
	function setChatBudget(state, budget) {
		const stale = contextBudget(state).analysis !== validateContextBudget(budget).analysis;
		state.contextBudget = copyValue(budget);
		if (stale) {
			for (const c of state.contacts || []) if (c.card) c.analysisStale = true;
		}
		return stale;
	}
	function setFollow(state, cfg, cards, on) {
		state.follow = { ...state.follow || {} };
		let stale = false;
		for (const card of cards) {
			state.follow[card] = on;
			if (on) for (const field of BOT_CARDS[card].fields) {
				if (field === "contextBudget") {
					if (!sameValue(contextBudget(state), cfg.contextBudget)) stale = setChatBudget(state, cfg.contextBudget) || stale;
				} else state[field] = copyValue(cfg[field]);
			}
		}
		return stale;
	}
	function settingText(field, value) {
		if (typeof value === "boolean") return value ? "켜짐" : "꺼짐";
		if (field === "mode") return (MODES[value] || MODES.balanced).label;
		if (field === "storySource") return (STORY_SOURCES.find(([id]) => id === value) || STORY_SOURCES[0])[1];
		if (field === "contextBudget") {
			const b = contextBudget({ contextBudget: value });
			return `${BUDGET_LABELS[b.mode]} ${b.analysis.toLocaleString()}자`;
		}
		if (field === "imageStyle") return (imageCfg.styles || []).find((s) => s.id === value)?.title || "기본 프리셋";
		if (field === "timeMode") return (TIME_MODES[value] || TIME_MODES.off).label;
		if (field === "timeSource") {
			const label = (TIME_SOURCES.find(([id]) => id === value?.kind) || TIME_SOURCES[0])[1];
			return value?.kind === "var" && value.var ? `${label} ${value.var}` : label;
		}
		return String(value ?? "");
	}
	function followChanges(state, cfg, cards) {
		return cards.filter((card) => !follows(state, card)).flatMap((card) => BOT_CARDS[card].fields.filter((field) => !sameValue(chatValue(state, field), cfg[field])).map((field) => `${BOT_CARDS[card].label}: ${BOT_FIELD_LABELS[field]} ${settingText(field, chatValue(state, field))} → ${settingText(field, cfg[field])}`));
	}
	async function botChats(ctx) {
		const known = new Set(await risuai.pluginStorage.keys() || []);
		return Promise.all((ctx.char.chats || []).map(async (chat, i) => {
			const key = STORE_PREFIX + ctx.char.chaId + ":" + (chat.id || "idx" + i);
			const loaded = states.get(key);
			const saved = loaded || (known.has(key) ? await readJson(key) : null);
			return {
				key,
				name: chat.name || `채팅 ${i + 1}`,
				state: saved && typeof saved === "object" ? saved : null,
				loaded: !!loaded,
				current: key === ctx.key
			};
		}));
	}
	const writeChatState = (row) => row.loaded ? saveState(row.key) : risuai.pluginStorage.setItem(row.key, JSON.stringify(row.state));
	const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

//#endregion
//#region src/chat/send.js
	const busyRooms = new Set();
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	function pushMessage(room, msg) {
		room.msgs.push(msg);
		if (room.msgs.length > MAX_ROOM_MSGS) room.msgs.splice(0, room.msgs.length - MAX_ROOM_MSGS);
	}
	async function requestReply(key, room) {
		const state = states.get(key);
		const roomKey = key + "|" + room.id;
		if (busyRooms.has(roomKey)) return;
		busyRooms.add(roomKey);
		const lastUser = lastTyped(room);
		const latestTyped = () => room.msgs.filter(typedMsg).at(-1)?.id;
		if (lastUser) delete lastUser.failed;
		room.error = "";
		render();
		const entry = await systemStart("reply", {
			version: PLUGIN_VERSION,
			phase: "context",
			bot: "",
			room: roomTitle(state, room, "me"),
			roomType: room.type,
			memberCount: room.members.length,
			historyCount: room.msgs.length,
			sent: lastUser?.text || "",
			request: lastUser?.text || "",
			raw: "",
			accepted: 0,
			delivered: 0,
			reasons: [],
			error: ""
		});
		try {
			const ctx = await getContext();
			if (!ctx || ctx.key !== key) throw new Error("다른 챗으로 이동해서 답장을 받지 못했습니다");
			const at = state.timeMode === "session" ? sessionStamp(sessionTime(ctx.chat, state.timeSource)) : null;
			if (at && lastUser && !lastUser.st) lastUser.st = at;
			entry.bot = ctx.char.name;
			entry.phase = "prompt";
			entry.contextUsage = [];
			const messages = await buildReplyMessages(ctx, state, room, entry.contextUsage);
			if (imageCfg.seePhotos === true && lastUser?.photo?.source && lastUser.photo.state === "done" && lastUser.photo.id) {
				const url = await photoFull(lastUser.photo.id);
				if (url) {
					messages[1] = {
						...messages[1],
						multimodals: [{
							type: "image",
							base64: url
						}]
					};
					entry.reasons.push({
						i: -1,
						why: "보낸 사진을 이미지로 함께 보냄"
					});
				}
			}
			state.lastContextUsage = entry.contextUsage;
			const pcName = await parseCbs("{{user}}");
			const actor = lastUser?.from || ownerOf(room);
			const members = respondersOf(state, room, actor, pcName);
			const actorContact = actor === "me" ? null : state.contacts.find((c) => c.id === actor);
			const policy = {
				pcName,
				contacts: state.contacts,
				transformText: (t) => fixTerms(t, members.filter((m) => !m.isUser)),
				report: entry.reasons,
				...actorContact ? { counterpartNames: [actorContact.name, ...actorContact.aliases || []] } : {}
			};
			const enforcePhoto = imageReady() && (imageCfg.ask === "easy" || room.r18 === true);
			const text = await askModel(messages, entry, "reply-model");
			entry.phase = "context-check";
			const current = await currentPlace();
			const liveRoom = state.rooms.find((r) => r.id === room.id);
			if (!current || current.key !== key || !state.enabled || liveRoom !== room || latestTyped() !== lastUser?.id) throw new Error("대화 상태가 바뀌어 답장을 저장하지 않았습니다");
			entry.phase = "parse";
			let reply = text;
			const decision = imageReady() ? parseCard(text)?.imageRequest : null;
			if (enforcePhoto && typeof decision?.requested !== "boolean") throw new Error("모델 응답에 이미지 요청 여부의 문맥 판정이 없어요. 답장을 저장하지 않았습니다. 시스템 로그를 확인해 주세요.");
			if (typeof decision?.requested === "boolean") entry.reasons.push({
				i: -1,
				why: `이미지 요청 문맥 판정: ${decision.requested ? "요청 있음" : "요청 없음"}`
			});
			const photoRequest = enforcePhoto && decision.requested;
			if (photoRequest) {
				const plan = decision;
				if (!plan || typeof plan.tags !== "string" || !plan.tags.trim() || !Array.isArray(plan.who)) throw new Error("사진 장면 태그를 작성하지 못했어요. 자동으로 재요청하지 않습니다. 다시 시도해 주세요.");
				const followups = parseCard(text)?.messages;
				reply = JSON.stringify({ messages: [{
					from: plan.from,
					to: ["me"],
					text: "",
					photo: {
						who: plan.who,
						tags: plan.tags,
						outfit: plan.outfit,
						omitLooks: plan.omitLooks,
						avoidCovering: plan.avoidCovering
					}
				}, ...Array.isArray(followups) ? followups.filter((m) => m && typeof m === "object").map(({ photo, ...m }) => m) : []] });
			}
			const lines = parseReply(reply, members, lastUser?.text, policy);
			if (photoRequest && !lines.some((l) => l.photo)) throw new Error("사진 장면의 인물 또는 태그가 유효하지 않아요. 자동으로 재요청하지 않습니다. 다시 시도해 주세요.");
			entry.parseMode = policy.parseMode;
			entry.accepted = lines.length;
			if (!lines.length) throw new Error("모델 답장에서 이 방에 쓸 수 있는 메시지를 찾지 못했어요. 시스템 로그에서 원인을 확인해 주세요.");
			entry.phase = "delivery";
			for (let i = 0; i < lines.length; i++) {
				if (i > 0) await sleep(Math.min(1500, 350 + lines[i].text.length * 25));
				const now = await currentPlace();
				if (!now || now.key !== key || !state.enabled || !state.rooms.includes(room) || latestTyped() !== lastUser?.id || !respondersOf(state, room, actor, pcName).some((m) => m.id === lines[i].from)) {
					throw new Error("대화 상태가 바뀌어 남은 답장을 저장하지 않았습니다");
				}
				const from = storedFrom(lines[i].from);
				const msg = {
					id: newId(),
					from,
					text: lines[i].text,
					t: Date.now(),
					...from === "me" ? { played: true } : {},
					...at ? { st: at } : {}
				};
				if (lines[i].photo) {
					const p = lines[i].photo, ids = (o) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [storedFrom(k), v]));
					msg.photo = {
						...p,
						who: p.who.map(storedFrom),
						...p.outfit ? { outfit: ids(p.outfit) } : {},
						...p.omitLooks ? { omitLooks: ids(p.omitLooks) } : {},
						r18: room.r18 === true
					};
				}
				pushMessage(room, msg);
				if (!(view.open && view.screen === "room" && view.key === key && view.roomId === room.id)) room.unread = (room.unread || 0) + 1;
				await saveState(key);
				entry.delivered++;
				render();
				if (msg.photo) queuePhoto(key, room.id, msg.id);
			}
			entry.phase = "complete";
			if (state.newMemory && state.memoryOn) void queueMemory(key, room.id);
		} catch (e) {
			if (lastUser) lastUser.failed = true;
			room.error = e.message;
			entry.error = e.message;
			await saveState(key);
		} finally {
			busyRooms.delete(roomKey);
			entry.durationMs = Date.now() - entry.t;
			await systemEnd(entry, entry.error ? "failed" : "success");
			await systemWait(logReply(entry));
			render();
		}
	}
	const DEBUG_KEY = "interlude:debug:v1";
	const DEBUG_MAX = 30;
	let debugLog = null;
	let debugQueue = Promise.resolve();
	let debugStorageError = false;
	function redactDebug(value) {
		return String(value ?? "").replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]").replace(/((?:api[_-]?key|authorization|access[_-]?token|secret)\s*["']?\s*[:=]\s*["']?)[^\s"'&,}<>]+/gi, "$1[REDACTED]").replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
	}
	function debugExcerpt(value, limit) {
		const text = redactDebug(value);
		if (text.length <= limit) return text;
		const half = Math.floor((limit - 60) / 2);
		return text.slice(0, half) + "\n… [중간 생략: 원문의 앞뒤를 보존함] …\n" + text.slice(-half);
	}
	function debugRecord(entry) {
		const raw = String(entry.raw || "");
		const out = {
			t: Number(entry.t) || Date.now(),
			raw: debugExcerpt(raw, 32e3),
			rawChars: Number(entry.rawChars) || raw.length,
			rawTruncated: !!entry.rawTruncated || raw.length > 32e3,
			error: debugExcerpt(entry.error, 2e3),
			reasons: (Array.isArray(entry.reasons) ? entry.reasons : []).slice(0, 100).map((r) => ({
				i: Number(r.i),
				why: debugExcerpt(r.why, 400)
			}))
		};
		for (const key of [
			"id",
			"version",
			"phase",
			"slot",
			"responseType",
			"parseMode",
			"roomType"
		]) out[key] = debugExcerpt(entry[key], 100);
		for (const key of [
			"bot",
			"room",
			"sent"
		]) out[key] = debugExcerpt(entry[key], key === "sent" ? 2e3 : 200);
		for (const key of [
			"accepted",
			"delivered",
			"durationMs",
			"processedChars",
			"chunks",
			"memberCount",
			"historyCount"
		]) {
			if (Number.isFinite(entry[key])) out[key] = entry[key];
		}
		out.thinkingRemoved = !!entry.thinkingRemoved;
		out.promptSizes = (Array.isArray(entry.promptSizes) ? entry.promptSizes : []).slice(0, 10).map((m) => ({
			role: [
				"system",
				"user",
				"assistant"
			].includes(m.role) ? m.role : "other",
			chars: Number(m.chars) || 0
		}));
		return out;
	}
	async function loadDebugLog() {
		if (debugLog) return debugLog;
		const saved = await readJson(DEBUG_KEY);
		debugLog = Array.isArray(saved) ? saved.filter((e) => e && typeof e === "object").slice(0, DEBUG_MAX).map(debugRecord) : [];
		return debugLog;
	}
	function logReply(entry) {
		const record = debugRecord(entry);
		debugQueue = debugQueue.then(async () => {
			const log = await loadDebugLog();
			log.unshift(record);
			log.length = Math.min(log.length, DEBUG_MAX);
			await risuai.pluginStorage.setItem(DEBUG_KEY, JSON.stringify(log));
			debugStorageError = false;
		}).catch(() => {
			debugStorageError = true;
			console.log("[interlude] debug log storage failed");
		});
		return debugQueue;
	}
	function clearDebugLog() {
		debugQueue = debugQueue.then(async () => {
			await risuai.pluginStorage.removeItem(DEBUG_KEY);
			debugLog = [];
			debugStorageError = false;
		}).catch(() => {
			debugStorageError = true;
		});
		return debugQueue;
	}
	function debugExport(entries, includeText) {
		const records = entries.map(debugRecord);
		return {
			type: "interlude-diagnostics",
			schema: 1,
			pluginVersion: PLUGIN_VERSION,
			exportedAt: new Date().toISOString(),
			includesText: !!includeText,
			note: "Model name, provider, reasoning effort, token usage and finish reason are not exposed by runLLMModel. raw is the text received by Interlude, not the provider HTTP response.",
			entries: includeText ? records : records.map((e) => ({
				id: e.id,
				t: e.t,
				version: e.version,
				phase: e.phase,
				slot: e.slot,
				responseType: e.responseType,
				parseMode: e.parseMode,
				durationMs: e.durationMs,
				chunks: e.chunks,
				rawChars: e.rawChars,
				rawTruncated: e.rawTruncated,
				processedChars: e.processedChars,
				thinkingRemoved: e.thinkingRemoved,
				accepted: e.accepted,
				delivered: e.delivered,
				memberCount: e.memberCount,
				historyCount: e.historyCount,
				promptSizes: e.promptSizes,
				failed: !!e.error,
				reasonCount: e.reasons.length
			}))
		};
	}
	async function polishText(key, room, acct, text) {
		const state = states.get(key), ctx = await getContext();
		if (!state || !ctx || ctx.key !== key) throw new Error("다른 챗으로 이동했어요.");
		const c = state.contacts.find((x) => x.id === acct);
		if (!c) throw new Error("계정 인물을 찾을 수 없어요.");
		const pcName = await parseCbs("{{user}}");
		const lore = await memberLore(ctx, [c], text, state, [], room);
		const who = (m) => m.from === acct ? c.name : m.from === "me" ? pcName : state.contacts.find((x) => x.id === m.from)?.name || "알 수 없음";
		const recent = room.msgs.slice(-12).map((m) => `${who(m)}: ${photoLine(m)}`).join("\n");
		const partner = roomPartner(state, room, acct);
		const to = room.type === "group" ? `단톡방 "${room.name}"의 사람들` : partner === view.me ? pcName : partner?.name || "상대";
		const prompt = `${c.name}이(가) 휴대폰 메신저로 ${to}에게 보낼 문자를 ${c.name}의 말투로 바꿔 쓴다.
[보낼 내용]은 ${c.name} 자신이 ${to}에게 하는 말이다. 사용자가 ${c.name}의 계정으로 대신 썼다.
이것은 답장이 아니다. [보낼 내용]에 반응하거나 대답하지 않는다. 같은 말을 ${c.name}이(가) 직접 한다면 어떻게 쓸지로 바꿔 쓴다.
말하는 사람(${c.name})과 듣는 사람(${to}), 누가 누구에게 무엇을 하는지는 그대로 둔다. 뜻, 내용, 사실, 약속, 감정도 그대로 두고 말투, 어미, 호칭, 문체만 ${c.name}답게 바꾼다.
실제 문자처럼 짧게 쓴다. 지문, 설명, 괄호 행동 묘사를 쓰지 않는다. 한국어로 쓴다.
[최근 대화]는 호칭과 흐름을 맞추는 참고용이다. 그 대화에 답하지 않는다.
JSON 하나만 출력한다: {"text":"바꿔 쓴 문자"}

[인물 설정]
${c.bio ? `한줄 소개: ${spell(c.bio)}\n` : ""}${lore || "(없음)"}

[최근 대화]
${recent || "(없음)"}

[보낼 내용]
${text}`;
		const raw = await askModel([{
			role: "user",
			content: prompt
		}], null, "polish");
		const plain = String(raw || "").replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?\s*>/gi, "").trim();
		const card = parseCard(plain);
		const out = (typeof card?.text === "string" ? card.text : plain).trim().replace(/^["“「](.*)["”」]$/s, "$1").trim();
		if (!out) throw new Error("모델이 빈 답을 보냈어요.");
		return out;
	}

//#endregion
//#region src/ui/base.js
	const PATHS = {
		swap: "M6.990 11L3 15l3.990 4v-3H14v-2H6.990v-3zM21 9l-3.990-4v3H10v2h7.010v3L21 9z",
		check: "M9 16.170L4.830 12l-1.420 1.410L9 19 21 7l-1.410-1.410z",
		back: "M15.5 4.5 8 12l7.5 7.5 1.5-1.5-6-6 6-6z",
		close: "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z",
		gear: "M19.4 13c.1-.3.1-.7.1-1s0-.7-.1-1l2-1.6-2-3.4-2.4 1c-.5-.4-1.1-.8-1.7-1L15 3.5h-4L10.7 6c-.6.2-1.2.6-1.7 1l-2.4-1-2 3.4 2 1.6c-.1.3-.1.7-.1 1s0 .7.1 1l-2 1.6 2 3.4 2.4-1c.5.4 1.1.8 1.7 1l.3 2.5h4l.3-2.5c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.4zM13 15.500a3.500 3.500 0 1 1 0-7 3.500 3.500 0 0 1 0 7z",
		pen: "M3 17.300V21h3.700L17.800 9.900l-3.700-3.700zM20.700 7a1 1 0 0 0 0-1.400l-2.300-2.300a1 1 0 0 0-1.400 0l-1.800 1.800 3.700 3.700z",
		search: "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
		chat: "M12 2C6.500 2 2 6.100 2 11.200c0 2.900 1.400 5.400 3.700 7.100V22l3.400-1.900c.9.300 1.900.4 2.900.4 5.500 0 10-4.100 10-9.300S17.500 2 12 2z",
		people: "M16 11a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7zM8 11a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7zm0 2c-2.700 0-7 1.300-7 4v3h14v-3c0-2.700-4.300-4-7-4zm8 0h-1c1.200.9 2 2.200 2 4v3h6v-3c0-2.700-4.300-4-7-4z",
		info: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z",
		send: "M2 21l21-9L2 3v7l15 2-15 2z",
		like: "M2 21h4V9H2zm20-11c0-1.100-.9-2-2-2h-6.300l1-4.600v-.3c0-.4-.2-.8-.4-1.100L13.200 1 6.600 7.600C6.200 8 6 8.500 6 9v10c0 1.100.9 2 2 2h9c.8 0 1.500-.5 1.800-1.200l3-7.100c.1-.2.2-.5.2-.7z",
		camera: "M9 3 7.200 5H4a2 2 0 0 0-2 2v12c0 1.100.9 2 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.200L15 3zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z",
		school: "M12 3 1 9l11 6 9-4.900V17h2V9zM5 13.200v4L12 21l7-3.800v-4L12 17z",
		book: "M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14V2zm0 16h12v2H6z",
		spark: "M12 2l2.200 6.800L21 11l-6.800 2.200L12 20l-2.200-6.800L3 11l6.800-2.200z",
		box: "M3 3h18v5H3zm1 7h16v11H4zm5 3v2h6v-2z",
		photo: "M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14c0 1.100.9 2 2 2h14a2 2 0 0 0 2-2zM8.500 13.500l2.500 3 3.500-4.500 4.500 6H5z",
		download: "M19 9h-4V3H9v6H5l7 7zM5 18v2h14v-2z",
		trash: "M6 19c0 1.100.9 2 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.500l-1-1h-5l-1 1H5v2h14z",
		refresh: "M17.650 6.350A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.730 10h-2.080A6 6 0 1 1 12 6c1.660 0 3.140.69 4.220 1.780L13 11h7V4z",
		prev: "M15.500 4.500 8 12l7.500 7.500 1.500-1.500-6-6 6-6z",
		next: "M8.500 4.500 16 12l-7.500 7.500L7 18l6-6-6-6z",
		more: "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"
	};
	const view = {
		key: "",
		ctx: null,
		open: false,
		screen: "list",
		tab: "chats",
		q: "",
		roomId: "",
		contactId: "",
		backTo: "list",
		scanning: false,
		notice: "",
		storyText: "",
		me: null
	};
	function h(tag, props, ...children) {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(props || {})) {
			if (k === "class") el.className = v;
			else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
			else if (v === true) el.setAttribute(k, "");
			else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v);
		}
		for (const child of children.flat()) {
			if (child !== null && child !== undefined && child !== false) el.append(child);
		}
		return el;
	}
	function icon(name, size = 20) {
		const box = h("span", {
			class: "ico",
			style: `width:${size}px;height:${size}px`
		});
		box.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="${PATHS[name]}"/></svg>`;
		return box;
	}
	const headUrls = new Map();
	function headUrl(path) {
		if (!headUrls.has(path)) headUrls.set(path, makeHeadUrl(path));
		return headUrls.get(path);
	}
	async function makeHeadUrl(path) {
		if (!path.startsWith("data:")) {
			const saved = await readJson(HEAD_CACHE + path);
			if (saved?.url) return saved.url;
		}
		const url = await imageUrl(path);
		if (!url || path.startsWith("data:")) return url;
		try {
			const img = new Image();
			img.src = url;
			await img.decode();
			const scale = Math.min(1, 240 / img.naturalWidth);
			const W = Math.max(1, Math.round(img.naturalWidth * scale)), H = Math.max(1, Math.round(img.naturalHeight * scale));
			const probe = document.createElement("canvas");
			probe.width = W;
			probe.height = H;
			const pc = probe.getContext("2d", { willReadFrequently: true });
			pc.drawImage(img, 0, 0, W, H);
			const px = pc.getImageData(0, 0, W, H).data;
			const solid = (x, y) => {
				const i = (y * W + x) * 4;
				return px[i + 3] > 40 && !(px[i] > 238 && px[i + 1] > 238 && px[i + 2] > 238);
			};
			let top = H, bottom = 0, minX = W, maxX = 0;
			for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (solid(x, y)) {
				if (y < top) top = y;
				if (y > bottom) bottom = y;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
			}
			const figure = bottom - top;
			if (figure <= 0 || H / W < 1.3 && maxX - minX > W * .85) return url;
			let sum = 0, count = 0;
			for (let y = top + Math.round(figure * .08); y < Math.min(H, top + Math.round(figure * .3)); y += 2) for (let x = 0; x < W; x += 2) if (solid(x, y)) {
				sum += x;
				count++;
			}
			const cx = count ? sum / count : (minX + maxX) / 2;
			const side = Math.min(W, H, Math.round(figure * .42));
			const left = Math.max(0, Math.min(W - side, Math.round(cx - side / 2)));
			const out = document.createElement("canvas");
			out.width = out.height = HEAD_SIZE;
			out.getContext("2d").drawImage(img, left / scale, top / scale, side / scale, side / scale, 0, 0, HEAD_SIZE, HEAD_SIZE);
			const small = out.toDataURL("image/webp", .82);
			await risuai.pluginStorage.setItem(HEAD_CACHE + path, JSON.stringify({ url: small }));
			return small;
		} catch (e) {
			console.log("[interlude] crop failed: " + e.message);
			void systemFailure("photo", e, "crop failed");
			return url;
		}
	}
	const lazyLoaders = new WeakMap();
	const lazyObserver = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			lazyObserver.unobserve(entry.target);
			lazyLoaders.get(entry.target)?.();
		}
	}, { rootMargin: "200px" });
	function lazily(el, load) {
		lazyLoaders.set(el, load);
		lazyObserver.observe(el);
		return el;
	}
	function validImageCrop(crop, source) {
		return crop && crop.source === source && [
			crop.x,
			crop.y,
			crop.zoom
		].every(Number.isFinite) && crop.x >= 0 && crop.x <= 1 && crop.y >= 0 && crop.y <= 1 && crop.zoom >= 1 && crop.zoom <= 6;
	}
	function cropRect(width, height, crop) {
		const side = Math.min(width, height) / crop.zoom;
		return {
			side,
			left: Math.max(0, Math.min(width - side, crop.x * width - side / 2)),
			top: Math.max(0, Math.min(height - side, crop.y * height - side / 2))
		};
	}
	const manualHeadUrls = new Map();
	async function profileImageUrl(contact) {
		const source = contact.image, crop = contact.imageCrop;
		if (!validImageCrop(crop, source)) return headUrl(source);
		const key = JSON.stringify([
			source,
			crop.x,
			crop.y,
			crop.zoom
		]);
		if (!manualHeadUrls.has(key)) {
			const pending = (async () => {
				const img = new Image();
				img.src = await imageUrl(source);
				await img.decode();
				const r = cropRect(img.naturalWidth, img.naturalHeight, crop);
				return squareImage(img, r.left, r.top, r.side, AVATAR_SIZE, .9);
			})();
			manualHeadUrls.set(key, pending);
			if (manualHeadUrls.size > 100) manualHeadUrls.delete(manualHeadUrls.keys().next().value);
		}
		try {
			return await manualHeadUrls.get(key);
		} catch {
			manualHeadUrls.delete(key);
			return imageUrl(source);
		}
	}
	function editProfileCrop(source, previous) {
		view.cancelCrop?.();
		return new Promise((resolve) => {
			const key = view.key, priorFocus = document.activeElement;
			let img = null, done = false, drag = null;
			const crop = validImageCrop(previous, source) ? { ...previous } : {
				source,
				x: .5,
				y: .5,
				zoom: 1
			};
			const finish = (value) => {
				if (done) return;
				done = true;
				overlay.remove();
				if (view.cancelCrop === cancel) delete view.cancelCrop;
				if (priorFocus?.isConnected) priorFocus.focus();
				resolve(value && view.key === key && view.open ? value : null);
			};
			const cancel = () => finish(null);
			const notice = h("div", {
				class: "sub",
				role: "status",
				"data-t": "crop-status"
			}, "이미지를 불러오는 중…");
			const canvas = h("canvas", {
				width: 320,
				height: 320,
				class: "crop-stage",
				tabindex: 0,
				role: "img",
				"aria-label": "프로필 표시 영역. 드래그 또는 방향키로 이동",
				"data-t": "crop-stage"
			});
			const small = h("canvas", {
				width: 80,
				height: 80,
				class: "crop-small",
				"aria-label": "원형 프로필 미리보기"
			});
			const draw = () => {
				if (!img || done) return;
				const r = cropRect(img.naturalWidth, img.naturalHeight, crop);
				crop.x = (r.left + r.side / 2) / img.naturalWidth;
				crop.y = (r.top + r.side / 2) / img.naturalHeight;
				for (const c of [canvas, small]) {
					const context = c.getContext("2d");
					context.clearRect(0, 0, c.width, c.height);
					context.drawImage(img, r.left, r.top, r.side, r.side, 0, 0, c.width, c.height);
				}
				zoom.value = String(crop.zoom);
				zoom.setAttribute("aria-valuetext", `${Math.round(crop.zoom * 100)}%`);
			};
			const zoom = h("input", {
				type: "range",
				min: 1,
				max: 6,
				step: .01,
				value: crop.zoom,
				disabled: true,
				"aria-label": "사진 확대",
				"data-t": "crop-zoom",
				oninput: () => {
					crop.zoom = Number(zoom.value);
					draw();
				}
			});
			const apply = h("button", {
				class: "pill primary",
				disabled: true,
				"data-t": "crop-apply",
				onclick: () => finish({ ...crop })
			}, "적용");
			canvas.addEventListener("pointerdown", (e) => {
				if (!img || e.pointerType === "mouse" && e.button !== 0) return;
				e.preventDefault();
				canvas.focus();
				canvas.setPointerCapture(e.pointerId);
				drag = {
					id: e.pointerId,
					x: e.clientX,
					y: e.clientY,
					cx: crop.x,
					cy: crop.y
				};
			});
			canvas.addEventListener("pointermove", (e) => {
				if (!drag || drag.id !== e.pointerId) return;
				const r = cropRect(img.naturalWidth, img.naturalHeight, crop);
				const scale = r.side / canvas.getBoundingClientRect().width;
				crop.x = drag.cx - (e.clientX - drag.x) * scale / img.naturalWidth;
				crop.y = drag.cy - (e.clientY - drag.y) * scale / img.naturalHeight;
				draw();
			});
			for (const type of [
				"pointerup",
				"pointercancel",
				"lostpointercapture"
			]) canvas.addEventListener(type, () => {
				drag = null;
			});
			canvas.addEventListener("keydown", (e) => {
				const delta = {
					ArrowLeft: [-1, 0],
					ArrowRight: [1, 0],
					ArrowUp: [0, -1],
					ArrowDown: [0, 1]
				}[e.key];
				if (!delta || !img) return;
				e.preventDefault();
				const step = cropRect(img.naturalWidth, img.naturalHeight, crop).side * (e.shiftKey ? .1 : .02);
				crop.x += delta[0] * step / img.naturalWidth;
				crop.y += delta[1] * step / img.naturalHeight;
				draw();
			});
			const overlay = h("div", {
				class: "crop-overlay",
				"data-t": "crop-dialog"
			}, h("div", {
				class: "crop-panel",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": "프로필 표시 영역 조정"
			}, h("h2", {}, "프로필 표시 영역"), notice, canvas, h("label", { class: "field" }, h("span", { class: "label" }, "확대·축소"), zoom), h("div", { class: "crop-preview" }, small, h("span", { class: "sub" }, "사진을 드래그해 위치를 맞춰 주세요. 방향키로도 이동할 수 있어요.")), h("div", { class: "actions" }, h("button", {
				class: "pill",
				"data-t": "crop-cancel",
				onclick: cancel
			}, "취소"), h("button", {
				class: "pill",
				"data-t": "crop-reset",
				onclick: () => {
					crop.x = crop.y = .5;
					crop.zoom = 1;
					draw();
				}
			}, "가운데로"), apply)));
			overlay.addEventListener("keydown", (e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					cancel();
				}
				if (e.key === "Tab") {
					const items = [...overlay.querySelectorAll("button:not(:disabled),input:not(:disabled),[tabindex=\"0\"]")];
					const next = items[(items.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + items.length) % items.length];
					e.preventDefault();
					next?.focus();
				}
			});
			document.body.append(overlay);
			view.cancelCrop = cancel;
			overlay.querySelector("[data-t=\"crop-cancel\"]").focus();
			(async () => {
				try {
					const url = await imageUrl(source);
					if (!url) throw Error("이미지를 찾지 못했어요.");
					const loaded = new Image();
					loaded.src = url;
					await loaded.decode();
					if (done) return;
					img = loaded;
					draw();
					apply.disabled = zoom.disabled = false;
					notice.textContent = "원 안에 보이는 부분이 프로필에 표시됩니다.";
				} catch {
					if (!done) {
						notice.textContent = "이미지를 불러오지 못했어요. 취소한 뒤 다른 사진을 골라 주세요.";
						notice.setAttribute("role", "alert");
					}
				}
			})();
		});
	}
	function avatar(contact, size, dot) {
		const box = h("span", {
			class: "av",
			style: `width:${size}px;height:${size}px;font-size:${Math.round(size * .42)}px`
		}, (contact?.name || "?").slice(0, 1));
		const mark = dot ? h("span", { class: "dot" }) : null;
		if (mark) box.append(mark);
		if (contact?.image) {
			lazily(box, () => profileImageUrl(contact).then((url) => {
				if (!url) return;
				box.textContent = "";
				box.append(h("img", {
					src: url,
					alt: ""
				}));
				if (mark) box.append(mark);
			}));
		}
		return box;
	}
	function roomAvatar(state, room, size, dot) {
		const members = roomMembers(state, room);
		if (room.type !== "group") {
			const p = roomPartner(state, room);
			return avatar(p, size, dot && p && p !== view.me && inStory(p));
		}
		const small = Math.round(size * .68);
		return h("span", {
			class: "stack",
			style: `width:${size}px;height:${size}px`
		}, avatar(members[0], small), avatar(members[1] || view.me, small));
	}
	function inStory(contact) {
		const state = states.get(view.key);
		return !!mentionEvidence(contact, view.storyText, [...state?.candidates || [], ...state?.contacts || []]);
	}
	const clock = (t) => {
		const d = new Date(t), hour = d.getHours();
		return `${hour < 12 ? "오전" : "오후"} ${hour % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`;
	};
	const ago = (t) => {
		const m = Math.max(0, Math.round((Date.now() - t) / 6e4));
		return m < 1 ? "방금" : m < 60 ? `${m}분` : m < 1440 ? `${Math.round(m / 60)}시간` : `${Math.round(m / 1440)}일`;
	};
	function closeWindow() {
		view.cancelCrop?.();
		view.open = false;
		risuai.hideContainer();
		syncFab();
	}
	const go = (screen, extra) => {
		view.cancelCrop?.();
		if (screen === "pick") view.noticePick = false;
		Object.assign(view, {
			screen,
			viewer: null
		}, extra);
		render();
	};
	const closeBtn = () => h("button", {
		class: "plain",
		"aria-label": "닫기",
		"data-t": "close",
		onclick: closeWindow
	}, icon("close", 22));
	const backBtn = (onclick) => h("button", {
		class: "plain",
		"aria-label": "뒤로",
		"data-t": "back",
		onclick
	}, icon("back", 24));
	const barTitle = (title) => h("div", { class: "top line-b" }, backBtn(() => go(view.backTo === "profile" ? "profile" : "list", { backTo: "list" })), h("h1", { class: "small" }, title), closeBtn());
	function toggleRow(label, desc, on, onchange, testId, scope) {
		return h("label", { class: "set" }, h("span", { class: "mid" }, scope ? h("span", {}, label, scopeTag(scope)) : label, desc ? h("small", {}, desc) : null), h("span", { class: "sw" }, h("input", {
			type: "checkbox",
			checked: on,
			"aria-label": label,
			"data-t": testId,
			onchange: (e) => onchange(e.target.checked)
		}), h("i")));
	}
	function confirmButton(label, onConfirm, testId) {
		const btn = h("button", {
			class: "set danger",
			"data-t": testId,
			onclick: () => {
				if (btn.dataset.armed) return onConfirm();
				btn.dataset.armed = "1";
				btn.textContent = "한 번 더 누르면 삭제합니다";
				setTimeout(() => {
					delete btn.dataset.armed;
					btn.textContent = label;
				}, 4e3);
			}
		}, label);
		return btn;
	}
	function dmRoom(state, contact) {
		let room = state.rooms.find((r) => r.type === "dm" && !r.as && r.members[0] === contact.id);
		if (!room) {
			room = {
				id: "dm:" + contact.id,
				type: "dm",
				name: contact.name,
				members: [contact.id],
				msgs: [],
				unread: 0
			};
			state.rooms.push(room);
		}
		return room;
	}
	const personOf = (state, id) => id === "me" ? view.me : state.contacts.find((c) => c.id === id);
	function dmRoomFor(state, id) {
		const acct = accountOf();
		if (acct === "me") return dmRoom(state, state.contacts.find((c) => c.id === id));
		if (id === "me") return dmRoom(state, state.contacts.find((c) => c.id === acct));
		let room = state.rooms.find((r) => r.type === "dm" && r.as === acct && r.members[0] === id);
		if (!room) {
			room = {
				id: `as:${acct}:${id}`,
				type: "dm",
				as: acct,
				name: state.contacts.find((c) => c.id === id)?.name || "대화",
				members: [id],
				msgs: [],
				unread: 0
			};
			state.rooms.push(room);
		}
		return room;
	}
	function roomPartner(state, room, acct = accountOf()) {
		if (room.type !== "dm") return null;
		if (!room.as && acct !== "me" && room.members[0] === acct) return view.me;
		return state.contacts.find((c) => c.id === room.members[0]);
	}
	function makeBackup(ctx, state, room = null) {
		const all = room ? [room] : state.rooms;
		const rooms = all.filter((r) => !r.as), accountRooms = all.filter((r) => r.as);
		const ids = new Set(all.flatMap(peopleOf));
		const contacts = room ? state.contacts.filter((c) => ids.has(c.id)) : state.contacts;
		return JSON.parse(JSON.stringify({
			type: "interlude-backup",
			version: 1,
			botId: ctx.char.chaId,
			botName: ctx.char.name,
			chatId: ctx.chat.id || "",
			chatName: ctx.chat.name || "",
			exportedAt: new Date().toISOString(),
			data: {
				contacts,
				rooms,
				...accountRooms.length ? { accountRooms } : {},
				...!room && state.contextBudget ? { contextBudget: backupBudget(contextBudget(state)) } : {}
			}
		}, (k, v) => k === "memRuns" ? undefined : v));
	}
	function mergeBackup(backup, current, ctx) {
		const fail = (text) => {
			throw new Error(text);
		};
		if (!backup || typeof backup !== "object" || Array.isArray(backup)) fail("메신저 백업 JSON이 아닙니다.");
		const single = ["dm", "group"].includes(backup.type) && Array.isArray(backup.msgs) && Array.isArray(backup.members);
		const modern = backup.type === "interlude-backup";
		if (backup.type && !single && (!modern || backup.version !== 1)) fail("지원하지 않는 백업 형식입니다.");
		if (modern && backup.botId !== ctx.char.chaId) fail("다른 봇의 백업입니다. 해당 봇의 챗에서 불러와 주세요.");
		const data = modern ? backup.data : single ? {
			contacts: [],
			rooms: [backup]
		} : backup;
		if (!data || !Array.isArray(data.contacts) || !Array.isArray(data.rooms)) fail("인물 정보와 대화방 목록이 필요합니다.");
		if (data.accountRooms !== undefined && !Array.isArray(data.accountRooms)) fail("캐릭터 계정의 대화방 목록이 잘못됐습니다.");
		const allRooms = [...data.rooms, ...data.accountRooms || []];
		if (data.contacts.length > 2e3 || allRooms.length > 1e3) fail("한 번에 불러올 수 있는 인물·대화방 수를 넘었습니다.");
		const text = (v, max, required = false) => {
			if (v === undefined && !required) return "";
			if (typeof v !== "string" || v.length > max || required && !v.trim()) fail("백업의 문자열 값이 잘못됐습니다.");
			return v;
		};
		const strings = (v, max) => {
			if (v === undefined) return [];
			if (!Array.isArray(v) || v.length > 100) fail("백업의 이름 목록이 잘못됐습니다.");
			return v.map((s) => text(s, max, true));
		};
		const generation = (g) => {
			if (g === undefined) return undefined;
			if (!g || g.schema !== 1 || !Array.isArray(g.chars) || g.chars.length > 100) fail("백업의 이미지 생성 정보가 잘못됐습니다.");
			if (g.charNegatives !== undefined && (!Array.isArray(g.charNegatives) || g.charNegatives.length > g.chars.length)) fail("백업의 인물 네거티브 정보가 잘못됐습니다.");
			const number = (v) => {
				if (!Number.isSafeInteger(v) || v < 0 || v > 1e10) fail("백업의 이미지 생성 수치가 잘못됐습니다.");
				return v;
			};
			return {
				schema: 1,
				base: text(g.base, 2e4),
				chars: g.chars.map((t) => text(t, 4e3)),
				negative: text(g.negative, 1e4),
				model: text(g.model, 200),
				width: number(g.width),
				height: number(g.height),
				seed: number(g.seed),
				...Array.isArray(g.charNegatives) ? { charNegatives: g.chars.map((_, i) => text(g.charNegatives[i], 4e3)) } : {},
				...g.edited === true ? { edited: true } : {},
				...Array.isArray(g.autoCovering) ? { autoCovering: g.autoCovering.map((t) => text(t, 200)) } : {},
				...Array.isArray(g.avoidCovering) ? { avoidCovering: selectedCovering(g.avoidCovering) } : {},
				...Array.isArray(g.coveringAdded) ? { coveringAdded: selectedCovering(g.coveringAdded) } : {},
				people: (Array.isArray(g.people) ? g.people.slice(0, 100) : []).map((p) => ({
					id: idMap.get(p.id) || "",
					name: text(p.name, 120)
				}))
			};
		};
		const contacts = JSON.parse(JSON.stringify(current.contacts || []));
		const rooms = JSON.parse(JSON.stringify(current.rooms || []));
		const idMap = new Map(), incomingIds = new Set();
		let addedContacts = 0, addedRooms = 0, addedMessages = 0, messagesRead = 0;
		const takenMemory = [];
		const takeMemory = (list) => {
			const items = importMemory(list);
			takenMemory.push(...items);
			return items;
		};
		for (const raw of data.contacts) {
			if (!raw || typeof raw !== "object") fail("잘못된 인물 정보입니다.");
			const originalId = text(raw.id, 200, true);
			if (originalId === "me" || incomingIds.has(originalId)) fail("인물 ID가 중복되거나 예약된 값입니다.");
			incomingIds.add(originalId);
			const c = {
				id: originalId,
				name: text(raw.name, 120, true),
				lore: text(raw.lore, 1e3),
				aliases: strings(raw.aliases, 120),
				keys: strings(raw.keys, 120)
			};
			if (raw.loreId !== undefined) c.loreId = text(raw.loreId, 200);
			const known = contacts.find((x) => resolvedPersonKey(x, [...contacts, ...data.contacts]) === resolvedPersonKey(c, [...contacts, ...data.contacts]));
			if (known) {
				mergeMemory(known, takeMemory(raw.memory));
				idMap.set(originalId, known.id);
				continue;
			}
			const used = new Set(contacts.map((x) => x.id));
			if (used.has(c.id)) c.id = newId();
			for (const [field, max] of [
				["bio", 1e3],
				["role", 1e3],
				["cardNote", 4e3],
				["userAddress", 40],
				["asset", 500],
				["image", 20 * 1024 * 1024]
			]) c[field] = text(raw[field], max);
			c.manualBio = raw.manualBio === true;
			const memory = takeMemory(raw.memory);
			if (memory.length) c.memory = memory;
			c.manualImage = raw.manualImage === true;
			if (validImageCrop(raw.imageCrop, c.image)) c.imageCrop = {
				source: c.image,
				x: raw.imageCrop.x,
				y: raw.imageCrop.y,
				zoom: raw.imageCrop.zoom
			};
			if (raw.card && typeof raw.card === "object" && !Array.isArray(raw.card) && JSON.stringify(raw.card).length < 5e4) {
				c.card = JSON.parse(JSON.stringify(raw.card));
				c.cardSchema = 0;
				c.loreHash = text(raw.loreHash, 100);
				if (raw.analysisLore !== undefined) c.analysisLore = text(raw.analysisLore, 1e5);
				const verified = raw.cardSchema === 2 && c.analysisLore ? verifiedSharedCard(c.card, c.analysisLore) : null;
				if (verified) {
					c.card = verified;
					c.cardSchema = 2;
				}
			}
			contacts.push(c);
			idMap.set(originalId, c.id);
			addedContacts++;
		}
		for (const x of takenMemory) if (x.with && idMap.has(x.with)) x.with = idMap.get(x.with);
		if (single) {
			for (const id of backup.members) if (contacts.some((c) => c.id === id)) idMap.set(id, id);
		}
		const origin = modern ? `${backup.botId}:${backup.chatId || ""}` : "legacy";
		const accountSet = new Set(data.accountRooms || []);
		for (const raw of allRooms) {
			if (!raw || typeof raw !== "object" || !Array.isArray(raw.members) || !Array.isArray(raw.msgs) || !["dm", "group"].includes(raw.type)) fail("잘못된 대화방 정보입니다.");
			const originalId = text(raw.id, 200, true);
			const missing = () => fail("대화 상대의 정보가 없습니다. 이전 개별 파일은 같은 챗에서 불러오거나 전체 백업을 사용해 주세요.");
			const as = accountSet.has(raw) ? idMap.get(text(raw.as, 200, true)) || missing() : "";
			const inRoom = (id) => members.includes(id) || !!as && id === as || !as && id === "me";
			const photoId = (id) => id === "me" ? "me" : idMap.get(id);
			const members = [...new Set(raw.members.map((id) => idMap.get(id) || missing()))];
			if (raw.type === "dm" && members.length !== 1 || raw.type === "group" && members.length < 2) fail("대화방 참가자 수가 잘못됐습니다.");
			const source = raw.importSource ? text(raw.importSource, 1e3, true) : origin + ":" + originalId;
			const sameMembers = (room) => room.type === raw.type && (room.as || "") === as && room.members.length === members.length && members.every((id) => room.members.includes(id));
			let room = raw.type === "dm" ? rooms.find((r) => sameMembers(r)) : rooms.find((r) => r.importSource === source || (!modern || backup.chatId === ctx.chat.id) && r.id === originalId && sameMembers(r));
			if (room && !sameMembers(room)) fail("같은 대화방 ID의 참가자 정보가 서로 다릅니다.");
			if (!room) {
				room = {
					id: newId(),
					type: raw.type,
					...as ? { as } : {},
					name: text(raw.name, 200) || contacts.find((c) => c.id === members[0])?.name || "대화방",
					members,
					msgs: [],
					unread: 0,
					inject: raw.inject !== false,
					r18: raw.r18 === true,
					importSource: source
				};
				rooms.push(room);
				addedRooms++;
			}
			for (let i = 0; i < raw.msgs.length; i++) {
				if (++messagesRead > 2e4) fail("한 번에 불러올 수 있는 메시지 수를 넘었습니다.");
				const m = raw.msgs[i];
				if (!m || typeof m !== "object") fail("잘못된 메시지입니다.");
				const from = m.from === "me" ? "me" : idMap.get(m.from);
				if (!from || !(as ? [as, ...members] : ["me", ...members]).includes(from)) fail("대화방 밖의 발신자가 들어 있는 백업입니다.");
				const photo = m.photo && typeof m.photo === "object" && !Array.isArray(m.photo) ? {
					id: text(m.photo.id, 200),
					tags: text(m.photo.tags, 2e3),
					r18: m.photo.r18 === true,
					generation: generation(m.photo.generation),
					promptOverride: generation(m.photo.promptOverride),
					...Array.isArray(m.photo.avoidCovering) ? { avoidCovering: selectedCovering(m.photo.avoidCovering) } : {},
					who: (Array.isArray(m.photo.who) ? m.photo.who : []).map(photoId).filter((id) => id && inRoom(id)),
					...m.photo.outfit && typeof m.photo.outfit === "object" && !Array.isArray(m.photo.outfit) ? { outfit: Object.fromEntries(Object.entries(m.photo.outfit).map(([id, v]) => [photoId(id), text(v, 400)]).filter(([id, v]) => id && inRoom(id) && v)) } : {},
					...m.photo.omitLooks && typeof m.photo.omitLooks === "object" && !Array.isArray(m.photo.omitLooks) ? { omitLooks: Object.fromEntries(Object.entries(m.photo.omitLooks).map(([id, v]) => [photoId(id), strings(v, 200)]).filter(([id]) => id && inRoom(id))) } : {},
					state: [
						"done",
						"failed",
						"deleted"
					].includes(m.photo.state) ? m.photo.state : "failed",
					...typeof m.photo.desc === "string" && m.photo.desc ? { desc: text(m.photo.desc, 1e3) } : {},
					...[
						"draw",
						"pick",
						"upload"
					].includes(m.photo.source) ? { source: m.photo.source } : {},
					...Number.isFinite(m.photo.w) && Number.isFinite(m.photo.h) ? {
						w: m.photo.w,
						h: m.photo.h
					} : {}
				} : null;
				const body = photo ? text(m.text, 5e4) : text(m.text, 5e4, true);
				const t = m.t === undefined ? 0 : m.t;
				if (typeof t !== "number" || !Number.isFinite(t) || t < 0) fail("메시지 시간이 잘못됐습니다.");
				const oldId = m.id === undefined ? "index-" + i : text(m.id, 200, true);
				const messageSource = m.importSource ? text(m.importSource, 1500, true) : source + ":" + oldId;
				const same = (existing) => existing.from === from && existing.text === body && existing.t === t && !!existing.failed === !!m.failed;
				if (room.msgs.some((x) => (x.importSource === messageSource || x.id === oldId) && same(x))) continue;
				const id = room.msgs.some((x) => x.id === oldId) ? newId() : oldId;
				if (m.editedAt !== undefined && (!Number.isFinite(m.editedAt) || m.editedAt < 0)) fail("메시지 수정 시간이 잘못됐습니다.");
				room.msgs.push({
					id,
					from,
					text: body,
					t,
					...Number.isFinite(m.editedAt) ? { editedAt: m.editedAt } : {},
					...m.failed === true ? { failed: true } : {},
					...from !== "me" && m.typed === true ? {
						typed: true,
						...m.polished === true ? { polished: true } : {}
					} : {},
					...from === "me" && m.played === true ? { played: true } : {},
					...photo ? { photo } : {},
					...m.st && typeof m.st === "object" ? { st: {
						date: String(m.st.date || "").slice(0, 60),
						time: String(m.st.time || "").slice(0, 60)
					} } : {},
					importSource: messageSource
				});
				addedMessages++;
			}
			if (room.msgs.length > MAX_ROOM_MSGS) fail(`대화방 하나에 ${MAX_ROOM_MSGS}개를 넘는 메시지를 병합할 수 없습니다. 기존 기록은 바뀌지 않았습니다.`);
			room.msgs.sort((a, b) => a.t - b.t);
		}
		const importedBudget = data.contextBudget && !current.contextBudget && !single ? validateContextBudget(data.contextBudget) : null;
		return {
			contacts,
			rooms,
			addedContacts,
			addedRooms,
			addedMessages,
			...importedBudget ? { contextBudget: importedBudget } : {}
		};
	}
	function downloadJson(name, data) {
		const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
		const a = h("a", {
			href: url,
			download: name
		});
		document.body.append(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 5e3);
	}
	function backupSection(state) {
		const counts = (plan) => `새 인물 ${plan.addedContacts}명 · 대화방 ${plan.addedRooms}개 · 메시지 ${plan.addedMessages}개 추가`;
		const file = h("input", {
			type: "file",
			accept: ".json,application/json",
			"aria-label": "메신저 백업 JSON",
			"data-t": "import-file",
			onchange: async () => {
				const picked = file.files?.[0], key = view.key;
				if (!picked) return;
				view.importError = "";
				view.importDraft = null;
				try {
					if (picked.size > 20 * 1024 * 1024) throw new Error("20MB 이하의 백업 파일을 골라 주세요.");
					const backup = JSON.parse(await picked.text());
					if (view.key !== key) return;
					const plan = mergeBackup(backup, state, view.ctx);
					view.importDraft = {
						key,
						backup,
						counts: counts(plan)
					};
				} catch (e) {
					if (view.key === key) view.importError = e.message;
				}
				if (view.key === key) render();
			}
		});
		const draft = view.importDraft?.key === view.key ? view.importDraft : null;
		return h("section", { class: "card" }, h("h3", {}, "대화 백업"), h("button", {
			class: "set",
			"data-t": "export-all",
			onclick: () => downloadJson(`interlude-${view.ctx.chat.name || "chat"}.json`, makeBackup(view.ctx, state))
		}, "대화 전체 내보내기"), h("label", { class: "field" }, h("span", { class: "label" }, "백업 불러오기 (JSON)"), file), view.importError ? h("div", {
			class: "notice flush",
			role: "alert",
			"data-t": "import-error"
		}, view.importError) : null, draft ? h("div", {
			class: "notice flush",
			"data-t": "import-preview"
		}, draft.counts, h("div", { class: "sub" }, "현재 기록과 병합합니다. 기존 호칭·메모·설정은 유지하고, 같은 메시지는 다시 추가하지 않아요."), h("button", {
			class: "pill primary",
			"data-t": "import-apply",
			onclick: async () => {
				try {
					if (view.analysis || view.scanning || [...busyRooms].some((k) => k.startsWith(view.key + "|"))) throw new Error("답장·분석·인물 찾기가 끝난 뒤 불러와 주세요.");
					const plan = mergeBackup(draft.backup, state, view.ctx);
					if (counts(plan) !== draft.counts) {
						draft.counts = counts(plan);
						view.importError = "기록이 바뀌어 미리보기를 갱신했어요. 확인 후 다시 눌러 주세요.";
						render();
						return;
					}
					const key = view.key, oldContacts = state.contacts, oldRooms = state.rooms, oldBudget = state.contextBudget;
					state.contacts = plan.contacts;
					state.rooms = plan.rooms;
					if (plan.contextBudget) state.contextBudget = plan.contextBudget;
					try {
						await saveState(key);
					} catch (e) {
						state.contacts = oldContacts;
						state.rooms = oldRooms;
						if (oldBudget === undefined) delete state.contextBudget;
						else state.contextBudget = oldBudget;
						throw e;
					}
					if (view.key !== key) return;
					view.importDraft = null;
					view.importError = "";
					view.notice = counts(plan) + " · 불러오기 완료";
					render();
				} catch (e) {
					view.importError = e.message;
					render();
				}
			}
		}, "현재 챗에 병합"), h("button", {
			class: "pill",
			"data-t": "import-cancel",
			onclick: () => {
				view.importDraft = null;
				render();
			}
		}, "취소")) : null, view.notice ? h("div", {
			class: "sub",
			"data-t": "backup-notice"
		}, view.notice) : null);
	}

//#endregion
//#region src/chat/accounts.js
	const ownerOf = (room) => room.as || "me";
	const peopleOf = (room) => [ownerOf(room), ...room.members];
	const inAccount = (room, acct) => acct === "me" ? !room.as : room.as === acct || !room.as && room.members.includes(acct);
	const roomsOf = (state, acct) => state.rooms.filter((r) => inAccount(r, acct));
	const accountOf = () => view.account || "me";
	const typedMsg = (m) => m.from === "me" ? m.played !== true : m.typed === true;
	const lastTyped = (room) => [...room.msgs].reverse().find(typedMsg);
	const factsOnly = (m) => m.typed === true && m.polished !== true && !!m.text;
	const USER_PID = "@user";
	const userPerson = (state, pcName) => ({
		id: USER_PID,
		name: pcName,
		aliases: [],
		bio: state.meBio || "",
		isUser: true
	});
	function respondersOf(state, room, actor, pcName) {
		return peopleOf(room).filter((id) => id !== actor).map((id) => id === "me" ? userPerson(state, pcName) : state.contacts.find((c) => c.id === id)).filter(Boolean);
	}
	const storedFrom = (id) => id === USER_PID ? "me" : id;

//#endregion
//#region src/chat/memory.js
	const MEMORY_TYPES = {
		fact: "설정",
		promise: "약속",
		user: "사용자",
		self: "자기 말",
		relation: "관계",
		photo: "사진"
	};
	const memoryOf = (c) => Array.isArray(c?.memory) ? c.memory : [];
	const memoryWords = (text) => [...new Set((String(text || "").match(/[가-힣a-zA-Z0-9]{2,}/g) || []).map((w) => w.replace(/(은|는|이|가|을|를|에|의|도|로|와|과|랑|하고|에서|이야|야|요)$/, "")).filter((w) => w.length >= 2 && !/^(오늘|지금|그럼|근데|그리고|그래|진짜|정말|그냥|나도|너도|우리)$/.test(w)))];
	function newMemory(type, text, by, where) {
		return {
			id: newId(),
			type,
			text: String(text).replace(/\s+/g, " ").trim().slice(0, MEMORY_TEXT),
			t: Date.now(),
			by,
			...where || {}
		};
	}
	function settleMemory(c) {
		const live = memoryOf(c).filter((x) => x.type !== "fact" && !x.pinned && !x.archived).sort((a, b) => a.t - b.t);
		for (const x of live.slice(0, Math.max(0, live.length - MEMORY_ACTIVE))) x.archived = true;
	}
	const memoryLabel = (x, nameOf) => x.with && nameOf ? `${MEMORY_TYPES[x.type] || "기억"} (${nameOf(x.with)} 계정의 대화)` : MEMORY_TYPES[x.type] || "기억";
	function memoryBlocks(members, recentText, report = [], nameOf = null) {
		const words = memoryWords(recentText);
		const facts = [], talk = [];
		let left = MEMORY_CHARS, recall = MEMORY_RECALL, source = 0, used = 0;
		for (const m of members) {
			const all = memoryOf(m);
			const f = all.filter((x) => x.type === "fact").map((x) => "- " + x.text);
			if (f.length) facts.push(`## ${m.name}\n${f.join("\n")}`);
			const rows = [];
			const live = all.filter((x) => x.type !== "fact" && !x.archived).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.t - a.t);
			for (const x of live) {
				const line = `- ${memoryLabel(x, nameOf)}: ${x.text}`;
				source += line.length + 1;
				if (line.length + 1 > left) continue;
				rows.push(line);
				left -= line.length + 1;
				used += line.length + 1;
			}
			const old = all.filter((x) => x.archived && !x.merged).map((x) => ({
				x,
				score: words.filter((w) => x.text.includes(w)).length
			})).filter((o) => o.score).sort((a, b) => b.score - a.score || b.x.t - a.x.t);
			for (const { x } of old) {
				const line = `- 지난 ${memoryLabel(x, nameOf)}: ${x.text}`;
				if (line.length + 1 > recall) continue;
				rows.push(line);
				recall -= line.length + 1;
				used += line.length + 1;
			}
			if (rows.length) talk.push(`## ${m.name}\n${rows.join("\n")}`);
		}
		report.push({
			section: "chatMemory",
			sourceChars: source,
			usedChars: used,
			limit: MEMORY_CHARS + MEMORY_RECALL,
			truncated: used < source
		});
		return {
			facts: facts.join("\n\n"),
			talk: talk.join("\n\n")
		};
	}
	function memoryPending(room) {
		const at = room.memUpTo ? room.msgs.findIndex((m) => m.id === room.memUpTo) : -1;
		return room.msgs.slice(at + 1).filter((m) => !m.failed);
	}
	function fixNames(text, names, source) {
		const known = [...new Set(names.filter((n) => /^[가-힣]{3,}$/.test(n || "")))];
		return text.replace(/[가-힣]{3,}/g, (word) => {
			if (source.includes(word)) return word;
			for (const name of known) {
				const head = word.slice(0, name.length);
				if (head.length !== name.length || head === name || source.includes(head)) continue;
				let diff = 0;
				for (let i = 0; i < name.length; i++) if (head[i] !== name[i]) diff++;
				if (diff === 1) return name + word.slice(name.length);
			}
			return word;
		});
	}
	function applyMemory(state, room, members, raw, source = "", names = []) {
		const owners = (who) => (Array.isArray(who) ? who : [who]).map((v) => typeof v !== "string" ? null : members.find((m) => m.id === v) || findMember(members, v)).filter(Boolean);
		const editable = (id) => {
			for (const m of members) {
				const x = memoryOf(m).find((y) => y.id === id);
				if (x) return x.type === "fact" || x.pinned || x.by === "user" ? null : {
					m,
					x
				};
			}
			return null;
		};
		const clean = (t) => typeof t === "string" ? fixNames(t.replace(/\s+/g, " ").trim(), names, source).slice(0, MEMORY_TEXT) : "";
		const where = {
			room: roomTitle(state, room, "me"),
			roomId: room.id,
			...room.as ? { with: room.as } : {}
		};
		let changed = 0;
		for (const a of Array.isArray(raw.add) ? raw.add.slice(0, 30) : []) {
			const text = clean(a?.text), type = Object.hasOwn(MEMORY_TYPES, a?.type) && a.type !== "fact" ? a.type : "self";
			if (!text) continue;
			const to = [...new Set(owners(a.who))];
			if (!to.length && members.length === 1) to.push(members[0]);
			for (const m of to) {
				if (memoryOf(m).some((x) => x.text === text)) continue;
				m.memory = [...memoryOf(m), newMemory(type, text, "model", where)];
				changed++;
			}
		}
		for (const u of Array.isArray(raw.update) ? raw.update : []) {
			const hit = editable(u?.id), text = clean(u?.text);
			if (!hit || !text) continue;
			Object.assign(hit.x, {
				text,
				t: Date.now()
			});
			changed++;
		}
		for (const g of Array.isArray(raw.merge) ? raw.merge : []) {
			const hits = [...new Set(Array.isArray(g?.ids) ? g.ids : [])].map(editable).filter(Boolean);
			const text = clean(g?.text), owner = hits[0]?.m;
			if (hits.length < 2 || !text || hits.some((x) => x.m !== owner)) continue;
			const merged = newMemory(hits[0].x.type, text, "model", where);
			for (const x of hits) Object.assign(x.x, {
				archived: true,
				merged: merged.id
			});
			owner.memory = [...memoryOf(owner), merged];
			changed++;
		}
		for (const r of Array.isArray(raw.archive) ? raw.archive : []) {
			const hit = editable(typeof r === "string" ? r : r?.id);
			if (!hit || hit.x.archived) continue;
			const text = clean(r?.text);
			Object.assign(hit.x, {
				archived: true,
				...text ? { text } : {}
			});
			changed++;
		}
		for (const m of members) settleMemory(m);
		return changed;
	}
	function promptIds(members, pcName) {
		const names = members.map((m) => normalize(m.name));
		const unique = new Set(names).size === names.length && !names.some((n) => !n || n === "me" || n === normalize(pcName));
		return (m) => unique ? m.name : m.id;
	}
	async function tidyMemory(key, roomId, force, rebuild = false) {
		const state = states.get(key);
		const room = state?.rooms.find((r) => r.id === roomId);
		if (!state || !room) return 0;
		const fresh = memoryPending(room);
		if (!fresh.length || !force && fresh.length < MEMORY_EVERY) return 0;
		const members = peopleOf(room).filter((id) => id !== "me").map((id) => state.contacts.find((c) => c.id === id)).filter(Boolean);
		if (!members.length) return 0;
		const batch = rebuild ? fresh.slice(0, MEMORY_BATCH) : fresh.slice(-MEMORY_BATCH);
		const pcName = await parseCbs("{{user}}");
		const owner = room.as ? state.contacts.find((c) => c.id === room.as)?.name || "알 수 없음" : "";
		const name = (id) => id === "me" ? pcName : state.contacts.find((c) => c.id === id)?.name || "알 수 없음";
		const promptId = promptIds(members, pcName);
		const known = members.map((m) => {
			const facts = memoryOf(m).filter((x) => x.type === "fact").map((x) => `- 설정: ${x.text}`);
			const rows = memoryOf(m).filter((x) => x.type !== "fact" && !x.archived).map((x) => `- [${x.id}] ${MEMORY_TYPES[x.type]}: ${x.text}${x.pinned || x.by === "user" ? " (고정)" : ""}`);
			return `### ${m.name} (ID ${promptId(m)})\n${[...facts, ...rows].join("\n") || "- (없음)"}`;
		}).join("\n\n");
		const log = batch.map((m) => `${name(m.from)}: ${factsOnly(m) ? "(사실만) " : ""}${photoLine(m)}`).join("\n");
		const names = [pcName, ...state.contacts.flatMap((c) => [c.name, ...c.aliases || []])].filter(Boolean);
		const prompt = `메신저 대화를 보고 각 인물의 대화 메모리를 정리한다.
${owner ? `이 방은 ${owner} 계정으로 나눈 대화다. 사용자 ${pcName}은(는) 이 방에 없다.` : `사용자: ${pcName} (ID me)`}
이 방: ${room.type === "group" ? `단톡방 "${room.name}"` : "1:1 대화"}
이름 표기: ${[...new Set(names)].slice(0, 60).join(", ")}

할 일:
- add: 나중 대화에 영향을 줄 새 사실만 추가한다. type은 promise(약속), user(${owner ? "대화 상대에 대해 알게 된 것" : "사용자에 대해 알게 된 것"}), self(자기가 한 말·한 일·밝힌 사실), relation(관계·감정의 변화), photo(보낸 사진과 그때 옷차림) 중 하나다.
- update: 이미 있는 메모리의 사실이 바뀌었으면 그 ID의 문장을 고친다.
- merge: 같은 인물의 비슷한 메모리 여러 개를 한 문장으로 합친다.
- archive: 지킨 약속, 더는 맞지 않는 사실처럼 지금은 덜 중요한 메모리를 보관으로 옮긴다. 필요하면 text로 "지킨 약속: ..."처럼 고쳐 쓴다. 지우지 않는다.
규칙:
- 인사, 맞장구, 그 자리에서 끝난 잡담은 쓰지 않는다. 간식, 잠깐 자리 비움, 방금 한 행동처럼 그날 안에 끝나는 일도 쓰지 않는다. 며칠 뒤 대화에도 영향을 줄 것만 쓴다. 새로 정리할 것이 없으면 모두 빈 배열이다.
- 이미 있는 메모리와 같은 내용은 다시 add하지 않는다. (고정) 표시와 설정 항목은 고치거나 합치거나 보관하지 않는다.
- who는 그 일을 직접 보고 들은 참가자 ID 배열이다. 단톡방이면 기억해야 할 사람을 모두 쓴다.
- text는 한국어 한 문장, 80자 안팎이다. 누가 무엇을 했는지 분명히 쓰고, ${owner ? "사람은 이름으로" : `사용자는 "${pcName}"(으)로`} 부른다. 이름은 위 이름 표기를 글자 그대로 쓰고, 다른 고유명사는 대화에 나온 표기를 따른다.
- 대화에 없는 일을 지어내지 않는다.${batch.some(factsOnly) ? "\n- (사실만)이 붙은 메시지는 문장이나 말투를 옮겨 쓰지 않고, 그 사람이 한 일·약속·밝힌 사실만 정리한다." : ""}
JSON 하나만 출력한다: {"add":[{"who":["참가자 ID"],"type":"promise","text":""}],"update":[{"id":"메모리 ID","text":""}],"merge":[{"ids":["메모리 ID","메모리 ID"],"text":""}],"archive":[{"id":"메모리 ID","text":""}]}

[참가자와 지금 메모리]
${known}

[새 대화]
${log}`;
		const raw = parseCard(await askModel([{
			role: "user",
			content: prompt
		}], null, "memory"));
		if (!raw) throw new Error("메모리 정리 응답을 해석하지 못했습니다");
		const before = new Map(members.flatMap((c) => memoryOf(c).map((x) => [x.id, memoryFields(x)])));
		const changed = applyMemory(state, room, members, raw, log + "\n" + known, names);
		const ops = [];
		for (const c of members) for (const x of memoryOf(c)) {
			const was = before.get(x.id);
			if (!was) ops.push({
				c: c.id,
				add: x.id
			});
			else if (MEMORY_FIELDS.some((k) => was[k] !== x[k])) ops.push({
				c: c.id,
				id: x.id,
				before: was
			});
		}
		state.memSeq = (state.memSeq || 0) + 1;
		room.memRuns = [...Array.isArray(room.memRuns) ? room.memRuns : [], {
			seq: state.memSeq,
			msgs: batch.map((m) => m.id),
			prevUpTo: room.memUpTo || "",
			ops
		}].slice(-MEMORY_RUNS);
		room.memUpTo = batch.at(-1).id;
		state.memoryError = "";
		await saveState(key);
		return changed;
	}
	const memoryJobs = new Set();
	let memoryChain = Promise.resolve();
	function queueMemory(key, roomId, force = false, rebuild = false) {
		const id = key + "|" + roomId;
		if (memoryJobs.has(id)) return memoryChain;
		memoryJobs.add(id);
		memoryChain = memoryChain.then(async () => {
			if (!rebuild) return tidyMemory(key, roomId, force);
			let changed = 0;
			for (let i = 0; i < Math.ceil(MAX_ROOM_MSGS / MEMORY_BATCH) + 1; i++) {
				const room = states.get(key)?.rooms.find((r) => r.id === roomId);
				if (!room || !memoryPending(room).length) break;
				const at = room.memUpTo;
				changed += await tidyMemory(key, roomId, true, true);
				if (room.memUpTo === at) break;
			}
			return changed;
		}).catch((e) => {
			console.log("[interlude] memory failed: " + e.message);
			const state = states.get(key);
			if (state) state.memoryError = e.message;
		}).finally(() => {
			memoryJobs.delete(id);
			render();
		});
		return memoryChain;
	}
	const MEMORY_FIELDS = [
		"text",
		"t",
		"archived",
		"merged"
	];
	const memoryFields = (x) => Object.fromEntries(MEMORY_FIELDS.map((k) => [k, x[k]]));
	const keptMemory = (x) => x.type === "fact" || x.pinned || x.by === "user";
	function memoryRewindPlan(state, room, ids, deleting) {
		const changedIds = new Set(ids);
		const runsOf = (r) => Array.isArray(r.memRuns) ? r.memRuns : [];
		const first = runsOf(room).findIndex((run) => run.msgs.some((id) => changedIds.has(id)));
		if (first < 0) return null;
		const since = runsOf(room)[first].seq;
		const cut = new Map([[room, first]]);
		for (let grew = true; grew;) {
			grew = false;
			const touched = new Set([...cut].flatMap(([r, k]) => runsOf(r).slice(k).flatMap((run) => run.ops.map((op) => op.add || op.id))));
			for (const r of state.rooms) {
				const k = runsOf(r).findIndex((run) => run.seq > since && run.ops.some((op) => op.id && touched.has(op.id)));
				if (k >= 0 && (!cut.has(r) || k < cut.get(r))) {
					cut.set(r, k);
					grew = true;
				}
			}
		}
		const gone = deleting ? changedIds : new Set();
		let calls = 0;
		const rooms = [...cut].map(([r, k]) => {
			const upTo = runsOf(r)[k].prevUpTo;
			const at = upTo ? r.msgs.findIndex((m) => m.id === upTo) : -1;
			calls += Math.ceil(r.msgs.slice(at + 1).filter((m) => !m.failed && !gone.has(m.id)).length / MEMORY_BATCH);
			return {
				room: r,
				k
			};
		});
		return {
			rooms,
			calls
		};
	}
	function moveMemoryPointer(room, upTo, gone) {
		let at = upTo ? room.msgs.findIndex((m) => m.id === upTo) : -1;
		while (at >= 0 && gone.has(room.msgs[at].id)) at--;
		if (at >= 0) room.memUpTo = room.msgs[at].id;
		else delete room.memUpTo;
	}
	function rewindMemory(state, plan, gone) {
		const runs = plan.rooms.flatMap(({ room, k }) => room.memRuns.slice(k)).sort((a, b) => b.seq - a.seq);
		for (const run of runs) for (const op of [...run.ops].reverse()) {
			const c = state.contacts.find((y) => y.id === op.c);
			const x = c && memoryOf(c).find((y) => y.id === (op.add || op.id));
			if (!x || keptMemory(x)) continue;
			if (op.add) c.memory = memoryOf(c).filter((y) => y !== x);
			else for (const k of MEMORY_FIELDS) {
				if (op.before[k] === undefined) delete x[k];
				else x[k] = op.before[k];
			}
		}
		for (const { room, k } of plan.rooms) {
			const upTo = room.memRuns[k].prevUpTo;
			room.memRuns = room.memRuns.slice(0, k);
			moveMemoryPointer(room, upTo, gone);
		}
	}
	async function memoryRewindChoice(key, state, room, ids, deleting) {
		if ([...memoryJobs].some((id) => id.startsWith(key + "|"))) await memoryChain;
		const plan = memoryRewindPlan(state, room, ids, deleting);
		return plan && plan.rooms.length === 1 && plan.calls <= 1 ? plan : null;
	}
	function importMemory(list) {
		if (!Array.isArray(list)) return [];
		const str = (v, max) => typeof v === "string" && v.length <= max ? v : "";
		return list.slice(0, 1e3).filter((x) => x && typeof x === "object" && Object.hasOwn(MEMORY_TYPES, x.type) && str(x.text, MEMORY_TEXT).trim()).map((x) => ({
			id: str(x.id, 60) || newId(),
			type: x.type,
			text: x.text.trim(),
			t: Number.isFinite(x.t) ? x.t : Date.now(),
			by: x.by === "user" ? "user" : "model",
			...x.pinned === true ? { pinned: true } : {},
			...x.archived === true ? { archived: true } : {},
			...str(x.merged, 60) ? { merged: x.merged } : {},
			...str(x.room, 120) ? { room: x.room } : {},
			...str(x.with, 200) ? { with: x.with } : {}
		}));
	}
	function mergeMemory(c, items) {
		const have = memoryOf(c);
		const add = items.filter((x) => !have.some((y) => y.id === x.id || y.text === x.text));
		if (add.length) c.memory = [...have, ...add];
	}
	const R18_MARKS = {
		off: "(— 이 지점에서 정조대 OFF로 바뀜. 위 메시지들의 거절·선 긋기는 바뀌기 전 설정에서 한 것이다 —)",
		on: "(— 이 지점에서 정조대 ON으로 바뀜. 여기부터는 일반 수위로 대화한다 —)"
	};
	function roomLog(state, room, pcName, limit, report = [], timeNow = { mode: "off" }) {
		const who = (m) => m.from === "me" ? pcName : state.contacts.find((c) => c.id === m.from)?.name || "알 수 없음";
		let lastSt = null;
		const entries = room.msgs.map((m, i) => {
			const line = `${who(m)}: ${factsOnly(m) ? "(말투 참고 제외) " : ""}${photoLine(m)}`;
			const gap = i ? m.t - room.msgs[i - 1].t : 0;
			if (timeNow.mode === "real" && gap >= REAL_GAP) return `(${gapText(gap)} 뒤)\n${line}`;
			if (timeNow.mode === "session" && m.st) {
				const moved = stampText(m.st) !== stampText(lastSt);
				lastSt = m.st;
				if (moved) return `[본편 시점: ${stampText(m.st)}]\n${line}`;
			}
			return line;
		});
		const mark = room.r18Mark, found = mark?.msgId ? room.msgs.findIndex((m) => m.id === mark.msgId) : -1;
		if (mark && (!mark.msgId || found >= 0) && mark.r18 === (room.r18 === true)) entries.splice(found + 1, 0, R18_MARKS[mark.r18 ? "off" : "on"]);
		const since = room.msgs.length ? Date.now() - room.msgs.at(-1).t : 0;
		if (timeNow.mode === "real" && since >= REAL_GAP) entries.push(`(지금: 마지막 메시지 ${gapText(since)} 뒤)`);
		const lines = [];
		let left = limit, total = 0, used = 0, cut = false;
		for (let i = entries.length - 1; i >= 0; i--) {
			const line = entries[i];
			total += line.length + 1;
			if (cut) continue;
			if (line.length + 1 > left && lines.length) {
				cut = true;
				continue;
			}
			const piece = line.length > left ? line.slice(-left) : line;
			lines.unshift(piece);
			left -= piece.length + 1;
			used += piece.length + 1;
		}
		report.push({
			section: "room",
			sourceChars: total,
			usedChars: used,
			limit,
			truncated: used < total
		});
		return lines.join("\n");
	}
	function recentOpenings(room, members) {
		return members.map((m) => {
			const starts = room.msgs.filter((x) => x.from === m.id && x.text && !factsOnly(x)).slice(-4).map((x) => x.text.trim().split(/\s+/).slice(0, 2).join(" ").slice(0, 14));
			return starts.length ? `${m.name}: ${[...new Set(starts)].map((s) => `"${s}"`).join(", ")}` : "";
		}).filter(Boolean).join("\n");
	}
	function modeRules(mode, storyIn, timeNow = { mode: "off" }) {
		const time = {
			story: "- 답장 시점은 아래 줄거리의 맨 끝이다. 메신저는 본편 장면 속에서 주고받는 문자이며, 줄거리에서 일어난 일과 각 인물이 실제로 아는 것만 반영한다.",
			balanced: "- 답장 시점은 본편 줄거리의 맨 끝을 기준으로 한다. 메신저 대화가 이어지면 이야기 속 시간도 대화 내용에 맞게 조금씩 흐를 수 있고, 그사이 식사·이동·휴식 같은 작은 일상 변화는 자연스럽게 반영한다. 본편 이야기와 일상 이야기를 섞는다.",
			free: "- 본편 줄거리는 지난 일로 참고만 하고, 지금의 근황·일상·새 화제를 중심으로 대화한다. 이야기 속 시간은 대화 내용에 맞게 자연스럽게 흐르고, 작은 일상 변화는 그 인물답게 만들어도 된다."
		}[mode];
		const held = "메신저의 지금은 [본편의 지금] 시점이다. 이 시점을 넘겨 시간을 흘리지 않는다.";
		const session = {
			story: `- ${held} 메신저는 본편 장면 속에서 주고받는 문자이며, 줄거리에서 일어난 일과 각 인물이 실제로 아는 것만 반영한다.`,
			balanced: `- ${held} 본편 이야기와 일상 이야기를 섞는다.`,
			free: `- 본편 줄거리는 지난 일로 참고만 하고, 지금의 근황·일상·새 화제를 중심으로 대화한다. ${held}`
		}[mode];
		const rules = [
			timeNow.mode === "session" ? storyIn ? session : `- 본편 줄거리는 주어지지 않는다. [참가자 설정], 메모리, 이 방의 대화만 근거로 답한다. ${held}` : storyIn ? time : "- 본편 줄거리는 주어지지 않는다. [참가자 설정], 메모리, 이 방의 대화만 근거로 답한다." + (mode === "story" ? "" : " 이야기 속 시간은 대화 내용에 맞게 흐른다."),
			"- 가장 최근 메시지에 먼저 답한다. 이미 끝난 화제나 지난 메시지를 다시 붙잡지 않는다.",
			"- 직전 답장들과 같은 말로 시작하거나 같은 문장 틀을 되풀이하지 않는다."
		];
		if (mode !== "story") rules.push("- 답장마다 새로운 것을 하나 더한다: 자기 근황, 감정, 질문, 제안 중 하나. 받기만 하지 말고 대화를 이어 간다.");
		if (mode === "free") rules.push("- 대화가 끊길 것 같으면 그 인물답게 먼저 새 화제를 꺼낸다.");
		if (timeNow.mode === "session") rules.push("- 대화 기록의 [본편 시점: …] 줄은 그 아래 메시지를 주고받은 본편 시점이다.");
		if (timeNow.mode === "real") rules.push("- [현재 시각]은 사용자의 실제 현재 시각이다. 대화 기록의 (… 뒤) 표시는 메시지 사이에 실제로 흐른 시간이다. 인사와 근황을 이 시간에 맞춘다.");
		if (timeNow.mode === "off" && storyIn) rules.push("- 줄거리 속 상태창의 날짜·시각 표기는 메신저 답장의 시간 판단에 쓰지 않는다.");
		return rules.join("\n");
	}
	const STORY_VIEW_CHARS = 2e3;
	const storyViewJobs = new WeakMap();
	const storyWriting = new Set();
	const textSig = (s) => {
		let h = 5381;
		for (let i = 0; i < s.length; i++) h = h * 33 + s.charCodeAt(i) | 0;
		return (h >>> 0).toString(36) + ":" + s.length;
	};
	async function storyViews(state, members, story, pcName, report, counterpart = null, onAsk = null) {
		const sig = textSig(story);
		const views = state.storyViews && typeof state.storyViews === "object" ? state.storyViews : {};
		state.storyViews = views;
		const slot = (m) => counterpart ? `${m.id}>${counterpart.id}` : m.id;
		const missing = members.filter((m) => views[slot(m)]?.sig !== sig);
		const other = counterpart ? counterpart.name : pcName;
		if (missing.length) {
			onAsk?.();
			let jobs = storyViewJobs.get(state);
			if (!jobs) storyViewJobs.set(state, jobs = new Map());
			const jobKeys = new Map(missing.map((m) => [m, JSON.stringify([
				story,
				pcName,
				counterpart?.id ?? null,
				other,
				m.id,
				m.name,
				m.aliases || []
			])]));
			const jobKey = (m) => jobKeys.get(m);
			const fresh = missing.filter((m) => !jobs.has(jobKey(m)));
			if (fresh.length) {
				const task = (async () => {
					const prompt = `아래 [본편 줄거리]는 모든 장면을 보는 서술자의 기록이다. 각 인물이 실제로 알 수 있는 것만 남긴 줄거리를 인물마다 따로 쓴다.
사용자: ${pcName}
인물: ${fresh.map((m) => m.name).join(", ")}
규칙:
- 그 인물이 그 자리에 있어 직접 보고 들은 일과, 줄거리 안에서 누군가에게 말로 전해 들은 일만 쓴다.
- 그 인물이 없던 장면, 다른 인물의 속마음, 서술자만 아는 묘사와 설명은 쓰지 않는다.
- 시간 순서대로 짧게 쓴다. 고유명사는 줄거리 표기를 그대로 쓰고, 줄거리에 없는 일을 지어내지 않는다.
- 마지막 줄은 "지금: "으로 시작해 줄거리 끝에서 그 인물이 어디서 무엇을 하는지, ${other}와(과) 같은 장소에 있는지 쓴다. 같은 장소에 없으면 ${other}의 지금 위치·소지품·행동 중 그 인물이 직접 보거나 전해 듣지 않은 것은 모른다고 쓴다.
- 그 인물이 줄거리에 나오지 않으면 "(직접 겪은 장면 없음)"과 "지금: 줄거리에 나오지 않음"만 쓴다.
- 인물당 ${STORY_VIEW_CHARS}자 이내.
JSON 하나만 출력한다: {"views":[{"who":"인물 이름","text":"그 인물이 아는 줄거리"}]}

[본편 줄거리]
${story}`;
					const raw = parseCard(await askModel([{
						role: "user",
						content: prompt
					}], null, "story-view"));
					const list = Array.isArray(raw?.views) ? raw.views : [];
					const result = new Map();
					for (const m of fresh) {
						const hit = list.find((v) => typeof v?.who === "string" && findMember([m], v.who));
						if (typeof hit?.text !== "string" || !hit.text.trim()) throw new Error(`${m.name}의 인물별 줄거리를 받지 못했습니다`);
						result.set(m.id, {
							sig,
							text: hit.text.trim().slice(0, STORY_VIEW_CHARS),
							t: Date.now()
						});
					}
					for (const m of fresh) views[slot(m)] = result.get(m.id);
					return result;
				})().finally(() => {
					for (const m of fresh) if (jobs.get(jobKey(m)) === task) jobs.delete(jobKey(m));
				});
				for (const m of fresh) jobs.set(jobKey(m), task);
			}
			const results = await Promise.all(missing.map((m) => jobs.get(jobKey(m)).then((result) => [slot(m), result.get(m.id)])));
			for (const [key, result] of results) views[key] = result;
			state.storyViews = views;
		}
		const text = members.map((m) => `## ${m.name}\n${views[slot(m)].text}`).join("\n\n");
		report.push({
			section: "storyView",
			sourceChars: story.length,
			usedChars: text.length,
			limit: STORY_VIEW_CHARS * members.length,
			truncated: false,
			cached: !missing.length
		});
		return text;
	}
	async function buildReplyMessages(ctx, state, room, report = []) {
		const pcName = await parseCbs("{{user}}");
		const actor = lastTyped(room)?.from || ownerOf(room);
		const asUser = actor === "me";
		const actorContact = asUser ? null : state.contacts.find((c) => c.id === actor) || null;
		const actorName = asUser ? pcName : actorContact?.name || "알 수 없음";
		const people = respondersOf(state, room, actor, pcName);
		const members = people.filter((p) => !p.isUser);
		const userPlays = people.some((p) => p.isUser);
		const names = people.map((m) => m.name);
		const promptId = promptIds(people, actorName);
		const budget = contextBudget(state);
		const mode = modeOf(state), plan = MODES[mode];
		const timeMode = Object.hasOwn(TIME_MODES, state.timeMode || "") ? state.timeMode : "off";
		const sessionNow = timeMode === "session" ? sessionTime(ctx.chat, state.timeSource) : null;
		const timeNow = {
			mode: timeMode === "session" && !sessionNow ? "off" : timeMode,
			now: sessionNow
		};
		const storyIn = state.storyIn !== false;
		const persona = budgetText(cleanStory(await parseCbs("{{persona}}")), budget.persona, "persona", report);
		const description = budgetText(cleanStory(await parseCbs(ctx.char.desc)), budget.description, "description", report);
		const lastMine = lastTyped(room)?.text;
		const lore = await memberLore(ctx, members, lastMine, state, report, room);
		const actorLore = actorContact ? await memberLore(ctx, [actorContact], lastMine, state, report, room) : "";
		const { text: story, ids: recentIds } = storyIn ? await storyWindow(ctx, plan.story) : {
			text: "",
			ids: new Set()
		};
		if (storyIn) report.push({
			section: "story",
			sourceChars: story.length,
			usedChars: story.length,
			limit: plan.story,
			truncated: false
		});
		let storyView = "";
		if (storyIn && story.trim()) {
			const writing = ctx.key + "|" + room.id;
			try {
				storyView = await storyViews(state, people, story, pcName, report, asUser ? null : {
					id: actor,
					name: actorName
				}, () => {
					storyWriting.add(writing);
					render();
				});
			} catch (e) {
				report.push({
					section: "storyView",
					sourceChars: story.length,
					usedChars: 0,
					limit: STORY_VIEW_CHARS * people.length,
					truncated: false,
					error: e.message
				});
			} finally {
				if (storyWriting.delete(writing)) render();
			}
		}
		const useMemory = state.newMemory === true;
		const remembered = storyIn && state.useSummary && useMemory ? await storyMemory(ctx, members, recentIds, plan.summary, state.storySource || "auto") : null;
		const summary = remembered ? remembered.text : storyIn && state.useSummary ? await legacySummary(ctx, members, recentIds) : "";
		if (remembered) {
			state.lastStoryMemory = {
				source: remembered.source,
				total: remembered.total,
				used: remembered.used,
				t: Date.now()
			};
			report.push({
				section: "storyMemory",
				sourceChars: summary.length,
				usedChars: summary.length,
				limit: plan.summary,
				truncated: remembered.used < remembered.total
			});
		}
		const log = roomLog(state, room, pcName, budget.roomHistory, report, timeNow);
		const nameOf = (id) => state.contacts.find((c) => c.id === id)?.name || "알 수 없음";
		const memo = useMemory ? memoryBlocks(members, room.msgs.slice(-6).map((m) => m.text).join("\n"), report, nameOf) : {
			facts: "",
			talk: ""
		};
		const actorFacts = actorContact && useMemory ? memoryBlocks([actorContact], "", [], nameOf).facts : "";
		const openings = recentOpenings(room, members);
		const typedOnly = room.msgs.some(factsOnly);
		const photoRule = imageReady() ? `
사진:
- 메시지 대신, 또는 메시지와 함께 사진을 보낼 수 있다. 사진 메시지는 {"from":"참가자 ID","to":["me"],"text":"사진과 함께 보낼 짧은 말, 없으면 빈 문자열","photo":{"who":["사진에 보이는 참가자 ID"],"tags":"영어 Danbooru 태그","outfit":{"참가자 ID":"그 인물의 옷 태그"}}} 형식이다.
- who는 셀카면 보내는 사람의 ID, 함께 찍었으면 보이는 참가자 ID들, 사물이나 풍경 사진이면 빈 배열이다. me는 넣지 않는다.
- tags에는 구도, 자세, 표정, 장소, 사물만 쓴다. 예: smile, peace sign, cafe, holding cup. 이름, 머리색, 눈색 같은 고정 외형과 옷은 쓰지 않는다. 코드가 붙인다.
- 대화 기록의 이전 사진 태그는 참고만 한다. 구도·자세·시점은 이번 요청과 장면에 맞게 새로 정하고, 이전 사진의 태그를 그대로 이어 붙이지 않는다.
- outfit은 사용자가 옷을 요청했을 때만 쓴다. 요청한 옷을 그 인물의 ID에 영어 Danbooru 태그로 쓴다. 요청이 없으면 outfit을 빼고, 코드가 평소 옷을 입힌다. 같은 대화에서 앞서 요청한 옷을 이어 입은 사진이면 그 옷을 다시 쓴다.
- 저장된 외형 태그 중 머리끈·리본·장신구처럼 탈착 가능한 장식을 이번 사진에 붙일지는 요청과 장면을 보고 판단한다. 사진에 보이는 인물마다 omitLooks:{"참가자 ID":["제외할 저장 장식 태그 원문"]}를 작성한다. 모두 유지하기로 판단했으면 빈 배열을 쓴다. 머리색·눈색·종족 등 고유 외형은 유지한다. 제외한 장식을 tags나 outfit에 다시 넣지 않는다.
- 사진에 nude 또는 naked를 쓰는 경우 avoidCovering:["억제할 가림 태그"]를 선택한다. 허용 후보: ${COVERING_CHOICES.join(", ")}. 인체 표현을 방해하는 원치 않는 가림만 고르고, 사용자가 요청한 자세·머리카락 배치·소품·조명·프레임은 보존한다. 예를 들어 팔짱을 요청했다면 crossed arms, arm across chest, convenient arm을 억제하지 않는다. 모든 후보를 일괄 선택하지 않는다. 가림을 억제할 필요가 없거나 nude/naked가 아니면 빈 배열이다. 선택한 항목을 긍정 tags나 outfit에 동시에 넣지 않는다. 수건·시트·맨몸에 걸친 옷·검열 같은 가리는 물건은 코드가 항상 네거티브에 넣으므로 후보에 없다.
- ${(PHOTO_FREQ[imageCfg.freq] || PHOTO_FREQ.normal)[1]} 한 번의 답장에 사진은 최대 1장이다.
- ${((room.r18 === true ? PHOTO_ASK.easy : PHOTO_ASK[imageCfg.ask]) || PHOTO_ASK.normal)[1]}
${imageCfg.ask === "easy" || room.r18 === true ? "- 쉬움 또는 정조대 OFF에서는 사진 부탁이 자발적으로 사진을 보내는 빈도와 인물의 망설임보다 우선이다. 말투와 감정은 인물답게 쓰되 사진을 미루는 이유로 쓰지 않는다. 이전 사진이 실제로 없으면 있었다고 꾸미지 말고 지금 새로 찍어 보낸다. 뒤이어 재촉하는 짧은 문자도 아직 보내지 않은 사진 부탁에 이어진 말로 읽는다." : ""}` : "";
		const imageDecisionRule = imageReady() ? `
이미지 요청 문맥 판정:
- 반드시 최상위 imageRequest 필드를 출력한다. 사용자가 지금 이미지를 요구하는지 이 방의 대화 흐름으로 판단한다. 이는 인물이 보내고 싶은지가 아니라 사용자 요청의 유무를 기록하는 사실 판정이다.
- 사진이라는 단어가 없어도 앞선 사진 부탁에 대한 재촉, 다시 보내기, 구도·표정·의상 변경 요구라면 requested=true다. 짧은 명령형과 생략된 표현도 문맥으로 읽는다. 취소·명시적 거절·다른 화제면 false다. 부정형 단어 하나만 보고 조건문을 취소로 오해하지 않는다.
- 요청이 없으면 "imageRequest":{"requested":false}다.
- 요청이 있으면 "imageRequest":{"requested":true,"from":"보내는 참가자 ID","who":["보이는 참가자 ID"],"tags":"영어 장면 태그","outfit":{"참가자 ID":"요청한 옷 태그"},"omitLooks":{"참가자 ID":["이번 사진에서 제외할 저장 장식 태그 원문"]},"avoidCovering":["선택한 가림 억제 태그"]}다. 기존 사진 규칙의 인물·구도·태그·의상·가림 억제 선택 형식을 따른다. 보통 설정에서 messages의 photo를 쓰는 경우에도 photo.avoidCovering에 같은 선택을 넣는다. 태그가 부족하면 현재 맥락으로 보완한다. 방 밖 인물이나 me를 who에 넣지 않는다.
${imageCfg.ask === "easy" || room.r18 === true ? "- 이 방에서는 이미지 요청이 확인되면 코드가 사진 메시지를 먼저 만든다. requested=true여도 messages에 사진 뒤에 보낼 그 인물다운 짧은 답장을 반드시 작성하고 imageRequest의 태그도 완성한다. messages에 사진을 중복해서 넣지 않는다. 인물의 망설임이나 과거 거절은 요청이 없다는 근거가 아니다." : "- 보통 설정에서는 인물이 전송 여부를 판단하고, 보내기로 했다면 기존 messages의 photo 형식을 쓴다. 요청 판정은 전송 여부와 별개로 기록한다."}
출력 예시 구조: {"imageRequest":{"requested":false},${storyIn ? "\"presence\":[{\"from\":\"참가자 ID\",\"withUser\":\"같이 있음 또는 떨어져 있음\",\"knows\":\"사용자에 대해 직접 알 수 있는 것\"}]," : ""}"messages":[{"from":"참가자 ID","to":["me"],"text":"답장"}]}.
` : "";
		const system = `너는 RP의 보조 작가다. 아래 줄거리와 설정을 바탕으로 휴대폰 메신저 답장만 쓴다.
${room.type === "group" ? `지금은 단톡방 "${room.name}"이다. 참가자: ${names.join(", ")}. 대화에 끼어들 만한 사람만 답한다. 다른 참가자가 이미 한 말과 같은 반응이나 같은 논지는 되풀이하지 않고, 참가자마다 자기 성격대로 다른 태도를 보인다. 할 말이 없는 사람은 답하지 않아도 된다.` : `지금은 ${names[0]}와(과) ${actorName}의 1:1 대화다.`}
이 방의 콘텐츠 설정: ${room.r18 === true ? "정조대 OFF. 이 방의 로컬 콘텐츠 제한을 해제한 상태다. 사용자가 요청한 성인 대상 표현 범위를 적용한다. 인물은 사용자의 요청에 협력하는 태도를 유지하고, 성격은 말투로 표현하되 같은 핑계로 대화를 막지 않는다. 요청하지 않은 수위를 덧붙이지 않는다. 대화 기록에 설정이 바뀐 표시가 있으면 그 이후부터 이 설정을 따른다. 바뀌기 전 메시지에서 거절하거나 선을 그었더라도 같은 이유로 다시 거절하지 않는다." : "정조대 ON (기본). 일반 대화와 사진을 기준으로 한다. 성적인 화제가 나오면 그 인물답게 가볍게 받아넘기거나 수위를 낮춰 답하고, 훈계하거나 대화를 차갑게 끊지 않는다. 대화 기록에 설정이 바뀐 표시가 있으면 그 이후부터 이 설정을 따른다."}
규칙:
- 각 인물의 정체, 종족, 소속, 직업, 나이대, 말투는 맨 아래 [참가자 설정]${useMemory ? "과 [설정 메모리]" : ""}가 가장 우선이다. 줄거리나 봇 설명과 다르면 이것을 따른다.
- 받은 메시지가 [참가자 설정]과 맞지 않는 전제를 깔면 그대로 맞장구치지 말고 그 인물답게 바로잡는다. 모르는 일을 지어내지 않고, 다른 신분이나 소속을 말하면 자기 것을 밝힌다.
${modeRules(mode, storyIn, timeNow)}${useMemory ? "\n- [본편 메모리]와 [대화 메모리]가 서로 다르면 시간상 나중에 일어난 일을 따른다. 각 인물은 자기 메모리에 있는 일만 안다." : ""}
- 줄거리나 설정상 아는 사이가 아니고 만난 적도 없으면 모르는 사람에게 연락받은 듯 반응한다.
- 사용자가 같은 부탁이나 제안을 다시 하면 같은 이유로 또 미루거나 거절하지 않는다. 그 인물답게 받아 주거나, 조건을 걸고 응하거나, 다른 방식으로 이어 간다. 정말 할 수 없는 일이면 거절은 한 번만 하고 화제를 넘긴다.
- 메신저 문자로 주고받는 대화다. 본편에서 지금 같은 장소에 함께 있는 인물만 사용자의 표정·안색·자세를 볼 수 있다. 떨어져 있으면 문자, 보낸 사진, 사용자가 말해 준 것으로만 상대 상태를 안다.${storyIn ? `
- 줄거리는 모든 장면을 보는 서술자의 기록이다. 각 인물은 자기가 그 자리에 있던 장면과 문자·사진·전해 들은 말로 받은 것만 안다. 자기가 없던 장면의 일은 모른다.${storyView ? "\n- [최근 줄거리]는 인물마다 그 인물이 직접 보고 들은 것만 정리한 것이다. 각 인물은 자기 몫에 있는 일만 알고, 다른 인물 몫에만 있는 일은 모른다." : ""}
- 답장을 쓰기 전에 presence에 인물마다 본편의 지금 장면에서 사용자와 같은 장소에 있는지(withUser)와, 그 인물이 사용자에 대해 직접 보거나 들어서 아는 것(knows)을 적는다.
- withUser가 떨어져 있음인 인물은 사용자의 위치, 소지품, 행동, 주변 상황, 소리를 보거나 들은 것처럼 말하지 않는다. knows에 없는 것을 아는 듯이 말하지 않는다.` : ""}
${asUser ? "" : `- [상대: ${actorName}]의 설정은 참고용이다. 각 인물은 줄거리와 관계상 ${actorName}에 대해 알 만한 것만 아는 듯이 말한다.
${userPlays ? `- ${pcName}도 이 방의 참가자로서 답한다. [참가자 설정]의 ${pcName} 설정과 말투를 따른다.` : `- ${pcName}은(는) 이 방에 없고 이 대화를 보지 않는다.`}
`}${typedOnly ? "- 대화 기록에서 (말투 참고 제외)가 붙은 메시지는 내용만 그 인물이 한 말로 인정한다. 그 인물이 답할 때 이 메시지의 말투와 문체를 따라 하지 않고 [참가자 설정]의 말투를 따른다.\n" : ""}- 줄거리${useMemory ? "와 메모리" : ""}에 없는 큰 사건을 지어내지 않는다. 보낸 메시지를 그대로 따라 하지 않는다.
- 각 인물의 말투를 지키고, 실제 문자처럼 짧게 쓴다. 지문, 설명, 태그, 괄호 행동 묘사를 쓰지 않는다.
- 대화 기록의 [사진 · 옷: ...]는 코드가 붙인 사진 참고 정보이며 인물이 보낸 문자가 아니다. 이 표기나 영어 사진 태그를 messages의 text에 복사하지 않는다. 사진 계획은 imageRequest 또는 photo 필드에만 쓰고, text에는 사용자에게 보낼 자연스러운 문자만 쓴다.
- 한국어로 쓴다. 인물당 1~3줄.
- 고유명사는 [참가자 설정]의 표기를 글자 그대로 쓴다.
출력 형식은 한 줄에 하나씩 정확히 다음과 같다:
JSON 하나: {${storyIn ? "\"presence\":[{\"from\":\"참가자 ID\",\"withUser\":\"같이 있음 또는 떨어져 있음\",\"knows\":\"사용자에 대해 직접 알 수 있는 것\"}]," : ""}"messages":[{"from":"참가자 ID","to":["me"],"text":"답장"}]}
${photoRule}
${imageDecisionRule}
${imageReady() ? `[저장된 외형 태그 · 이번 사진의 장식 유지 여부 판단에 참고]\n${members.map((m) => `${promptId(m)}: ${tagParts(m.imageTags).looks || "(미등록)"}`).join("\n")}` : ""}

${asUser ? `[PC: ${pcName}]${state.meBio ? `\n한줄 소개: ${state.meBio}` : ""}
${persona}
` : `[상대: ${actorName} - 이 방에서 메시지를 보내는 사람]${actorContact?.bio ? `\n한줄 소개: ${spell(actorContact.bio)}` : ""}
${actorLore || "(없음)"}${actorFacts ? `\n설정 메모리:\n${actorFacts}` : ""}
`}
[봇 설명]
${description}

${summary ? `${useMemory ? "[본편 메모리 - 앞선 줄거리 요약]" : "[앞선 줄거리 요약]"}\n${summary}\n\n` : ""}${storyView ? `[최근 줄거리 - 인물마다 그 인물이 직접 보고 들은 것만]\n${storyView}\n\n` : storyIn ? `[최근 줄거리]\n${story}\n\n` : ""}[참가자 설정]
${members.filter((m) => m.bio).map((m) => `${m.name}의 한줄 소개: ${spell(m.bio)}`).join("\n")}
${userPlays ? `## ${pcName}${state.meBio ? `\n한줄 소개: ${state.meBio}` : ""}\n${persona || "(없음)"}\n\n` : ""}${lore || "(없음)"}
${memo.facts ? `\n[설정 메모리 - 사용자가 확정한 사실. 다른 메모리와 줄거리보다 우선]\n${memo.facts}\n` : ""}
[현재 메신저 방: 코드가 정한 경계]
${asUser ? `사용자 ID는 me, 이름은 ${pcName}이다. 사용자는 로어의 동료·가족·주인공과 자동으로 동일한 사람이 되지 않는다.` : `상대 ID는 me, 이름은 ${actorName}이다.`}
답장을 보낼 수 있는 ID: ${JSON.stringify(people.map((m) => ({
			id: promptId(m),
			name: m.name
		})))}
수신 가능한 ID는 me와 위 참가자 ID뿐이다. from은 위 참가자 ID만, to는 수신 가능한 ID의 배열만 쓴다.
본편에서 같은 장소에 있는 인물도 이 방 참가자가 아니면 메시지를 듣거나 받지 않는다. 그 인물에 관한 이야기는 가능하지만 그 인물에게 직접 말을 걸거나 도움을 요청하지 않는다.
${asUser ? `호칭은 현재 수신자의 이름을 기본으로 쓴다. 로어 대사 예시·관계 설명의 호칭을 현재 사용자에게 옮겨 쓰지 않는다.
${members.map((m) => m.userAddress ? `${m.name}가 현재 사용자에게 쓸 호칭(사용자가 지정): ${m.userAddress}` : `${m.name}가 현재 사용자에게 쓸 호칭: 이 방 대화에서 이미 써 온 호칭이 있으면 그대로 이어 쓰고, 없으면 ${pcName}`).join("\n")}` : `호칭은 이 방 대화에서 이미 써 온 호칭이 있으면 그대로 이어 쓰고, 없으면 설정과 줄거리에서 그 인물이 상대를 부르는 호칭을 쓴다. 그런 호칭이 없으면 이름을 쓴다.`}
각 답장은 이 경계를 지키는 짧은 문자 내용만 담는다. 참가자나 수신자를 추가하지 않는다.`;
		const user = `${memo.talk ? `[대화 메모리 - 이 챗의 메신저에서 생긴 일. 각 인물은 자기 것만 안다]\n${memo.talk}\n\n` : ""}${timeNow.mode === "session" ? `[본편의 지금]\n${stampText(timeNow.now)}\n\n` : timeNow.mode === "real" ? `[현재 시각]\n${realNow()}\n\n` : ""}[이 방의 대화 기록]
${log}

${openings ? `[최근 첫마디 - 이 말로 다시 시작하지 않는다]\n${openings}\n\n` : ""}위 기록의 마지막 메시지에 대한 답장을 지금 출력한다.${imageReady() ? " 사용자에게 보여 줄 답장과 별개로 imageRequest에 이미지 요청의 문맥 판정을 반드시 포함한다." : ""}`;
		globalThis.__interludeLastPrompt = {
			system: system.length,
			user: user.length,
			story: story.length,
			summary: summary.length,
			lore: lore.length,
			memory: memo.talk.length + memo.facts.length
		};
		return [{
			role: "system",
			content: forCounterpart(system, asUser)
		}, {
			role: "user",
			content: forCounterpart(user, asUser)
		}];
	}
	const COUNTERPART_PHRASES = [
		"사용자가 옷을 요청했을 때만",
		"사용자가 요청한 자세·머리카락",
		"사용자가 지금 이미지를 요구하는지",
		"사용자 요청의 유무",
		"사용자에 대해 직접 알 수 있는 것",
		"사용자가 요청한 성인 대상 표현 범위",
		"사용자의 요청에 협력하는",
		"사용자가 같은 부탁이나 제안을",
		"사용자의 표정·안색·자세",
		"사용자가 말해 준 것으로만",
		"사용자와 같은 장소에 있는지(withUser)",
		"사용자에 대해 직접 보거나 들어서",
		"사용자의 위치, 소지품",
		"사용자에게 보낼 자연스러운 문자만",
		"사용자에게 보여 줄 답장과 별개로",
		"사용자가 사진을 부탁하면"
	];
	const forCounterpart = (text, asUser) => asUser ? text : COUNTERPART_PHRASES.reduce((t, p) => t.split(p).join(p.replace("사용자", "상대")), text);
	function findMember(members, name) {
		const target = normalize(name);
		return members.find((m) => normalize(m.name) === target) || members.find((m) => (m.aliases || []).some((a) => normalize(a) === target));
	}
	function addressesOutsider(text, members, policy) {
		if (!policy) return false;
		const knownNames = (c) => [c.name, ...c.aliases || []];
		const allowed = new Set([
			policy.pcName,
			policy.userAddress,
			...policy.counterpartNames || [],
			...members.flatMap((c) => [...knownNames(c), c.userAddress])
		].filter(Boolean).map(normalize));
		const outside = (policy.contacts || []).filter((c) => !members.some((m) => m.id === c.id)).flatMap(knownNames);
		return outside.filter((n) => typeof n === "string" && n.trim().length >= 2 && !allowed.has(normalize(n))).some((name) => {
			const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`(?:^|[.!?…\\n]\\s*|["“])${escaped}(?:[아야]?\\s*[,，:：!]|[아야](?=\\s|[.!?]))`, "i").test(text.trim());
		});
	}
	function jsonObjects(text, spans) {
		try {
			const doc = JSON.parse(text);
			if (spans) spans.push({
				start: 0,
				end: text.length
			});
			return [doc];
		} catch {}
		const out = [];
		let attempts = 0;
		for (let start = text.indexOf("{"); start >= 0 && attempts++ < 256; start = text.indexOf("{", start + 1)) {
			let depth = 0, inString = false, escaped = false;
			for (let i = start; i < text.length; i++) {
				const ch = text[i];
				if (inString) {
					if (escaped) escaped = false;
					else if (ch === "\\") escaped = true;
					else if (ch === "\"") inString = false;
				} else if (ch === "\"") inString = true;
				else if (ch === "{") depth++;
				else if (ch === "}" && --depth === 0) {
					try {
						out.push(JSON.parse(text.slice(start, i + 1)));
						if (spans) spans.push({
							start,
							end: i + 1
						});
						start = i;
					} catch {}
					break;
				}
			}
		}
		return out;
	}
	function photoReplyText(text) {
		return String(text || "").replace(/^[\t ]*\[사진(?:\s*[:：]\s*([^\]\r\n]*)|\s*·\s*옷\s*[:：]\s*[^\]\r\n]*)?\](?=\s|$)[\t ]*/gm, (marker, payload) => {
			if (payload === undefined) return "";
			const tags = payload.split(/\s*·\s*옷\s*[:：]/)[0].trim();
			return tags && /^[\x20-\x7e]+$/.test(tags) ? "" : marker;
		}).trim();
	}
	function parseReply(text, members, lastUserText, policy) {
		text = String(text || "").replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?\s*>/gi, "").replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/gi, "").trim();
		const out = [];
		const report = policy?.report || null;
		const reject = (i, why) => {
			if (report) report.push({
				i,
				why
			});
		};
		const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
		const structured = /^[{[]/.test(jsonText);
		const spans = [];
		let docs = jsonObjects(jsonText, spans);
		const recovered = !structured && docs.some((d) => Array.isArray(d?.messages));
		if (recovered) {
			const last = docs.map((d) => Array.isArray(d?.messages)).lastIndexOf(true);
			if (jsonText.slice(spans[last].end).trim()) {
				if (policy) policy.parseMode = "recovery-rejected";
				reject(-1, "JSON 뒤에 다른 내용이나 미완성 응답이 있어 최종 답장으로 확정할 수 없음");
				return [];
			}
			docs = [docs[last]];
		}
		if (policy) policy.parseMode = recovered ? "recovered-json" : structured ? "json" : "tagged";
		if (structured || recovered) {
			const list = docs.flatMap((d) => Array.isArray(d?.messages) ? d.messages : []);
			if (!docs.length) {
				reject(-1, "JSON으로 읽을 수 없는 응답");
				return [];
			}
			if (!list.length) {
				reject(-1, "messages 목록이 없는 응답");
				return [];
			}
			if (docs.length > 1) reject(-1, `JSON ${docs.length}개가 이어져 와서 합쳐 읽음`);
			const allowed = new Set(["me", ...members.map((m) => m.id)]);
			const memberId = (v) => typeof v !== "string" ? "" : members.some((c) => c.id === v) ? v : findMember(members, v)?.id || "";
			const pcs = (policy?.counterpartNames || [policy?.pcName || ""]).map(normalize).filter(Boolean);
			const recipient = (v) => v === "me" || typeof v === "string" && pcs.includes(normalize(v)) ? "me" : memberId(v) || v;
			let photos = 0;
			list.forEach((m, i) => {
				let photo = null;
				if (m?.photo && typeof m.photo === "object" && !Array.isArray(m.photo)) {
					if (!imageReady()) reject(i, "사진 기능이 꺼져 있어 사진은 빼고 읽음");
					else if (photos >= 1) reject(i, "한 답장에 사진은 1장만 그림");
					else {
						const who = [...new Set((Array.isArray(m.photo.who) ? m.photo.who : []).map(memberId).filter(Boolean))];
						const tags = cleanTags(m.photo.tags);
						const outfit = {};
						if (m.photo.outfit && typeof m.photo.outfit === "object" && !Array.isArray(m.photo.outfit)) {
							for (const [k, v] of Object.entries(m.photo.outfit)) {
								const id = memberId(k), worn = cleanTags(v);
								if (id && worn && who.includes(id)) outfit[id] = worn;
							}
						} else if (typeof m.photo.outfit === "string" && who.length === 1 && cleanTags(m.photo.outfit)) outfit[who[0]] = cleanTags(m.photo.outfit);
						const omitLooks = {};
						if (m.photo.omitLooks && typeof m.photo.omitLooks === "object" && !Array.isArray(m.photo.omitLooks)) {
							for (const [k, v] of Object.entries(m.photo.omitLooks)) {
								const id = memberId(k);
								if (id && who.includes(id) && Array.isArray(v)) omitLooks[id] = [...new Set(v.filter((t) => typeof t === "string").slice(0, 100).map((t) => cleanTags(t, 200)).filter(Boolean))];
							}
						}
						const avoidCovering = selectedCovering(m.photo.avoidCovering);
						if (tags || who.length) {
							photo = {
								who,
								tags,
								...Object.keys(outfit).length ? { outfit } : {},
								...Object.keys(omitLooks).length ? { omitLooks } : {},
								...avoidCovering.length ? { avoidCovering } : {},
								state: "pending"
							};
							photos++;
						}
					}
				}
				const from = memberId(m?.from);
				if (!m || !from) return reject(i, `보낸 사람이 이 방 참가자가 아님: ${JSON.stringify(m?.from ?? null)}`);
				if (typeof m.text !== "string" && !photo) return reject(i, "내용이 없음");
				const to = Array.isArray(m.to) ? m.to.map(recipient) : [];
				if (!to.length || to.some((id) => !allowed.has(id))) return reject(i, `받는 사람이 맞지 않음: ${JSON.stringify(m.to ?? null)}`);
				out.push({
					i,
					from,
					text: typeof m.text === "string" ? m.text.trim() : "",
					photo
				});
			});
		} else {
			text.split("\n").map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
				const m = line.match(/^@?\s*([^:：@]{1,60})\s*[:：]\s*(.+)$/);
				const member = m && findMember(members, m[1]);
				if (member) out.push({
					i,
					from: member.id,
					text: m[2].trim()
				});
				else reject(i, "형식을 알 수 없는 줄");
			});
		}
		const echo = normalize(lastUserText);
		return out.map((l) => {
			const text = photoReplyText(l.text);
			if (text !== l.text) reject(l.i, "대화 기록용 사진 태그 표기를 답장에서 제외함");
			return {
				...l,
				text: text && policy?.transformText ? policy.transformText(text) : text
			};
		}).filter((l) => {
			if (!l.photo && (!l.text || normalize(l.text) === echo)) {
				reject(l.i, l.text ? "보낸 메시지를 그대로 따라함" : "내용이 없음");
				return false;
			}
			if (addressesOutsider(l.text, members, policy)) {
				reject(l.i, "이 방에 없는 인물을 직접 부름");
				return false;
			}
			return true;
		}).slice(0, 8).map(({ i, ...l }) => l);
	}

//#endregion
//#region src/chat/inject.js
	function messengerNote(state, pcName) {
		const rows = [];
		for (const room of state.rooms) {
			if (room.inject === false) continue;
			const partner = state.contacts.find((c) => c.id === room.members[0])?.name || "?";
			const owner = room.as ? state.contacts.find((c) => c.id === room.as)?.name || "?" : "";
			const label = owner ? room.type === "group" ? `${owner} 계정의 단톡방 ${room.name}, ${pcName} 없음` : `${owner}-${partner} 1:1, ${owner}와(과) ${partner}가 주고받은 문자, ${pcName} 없음` : room.type === "group" ? `단톡방 ${room.name}` : `${pcName}-${partner} 1:1`;
			for (const m of room.msgs) {
				if (m.failed) continue;
				const who = m.from === "me" ? pcName : state.contacts.find((c) => c.id === m.from)?.name || "?";
				rows.push({
					t: m.t,
					line: `(${label}) ${who}: ${photoLine(m)}`
				});
			}
		}
		const memo = [];
		let left = MEMORY_INJECT;
		const hidden = new Set(state.rooms.filter((r) => r.inject === false).map((r) => r.id));
		for (const c of state.newMemory ? state.contacts : []) {
			const items = memoryOf(c).filter((x) => x.type !== "fact" && !x.archived && !hidden.has(x.roomId)).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.t - a.t);
			for (const x of items) {
				const line = x.with ? `- ${c.name} (${state.contacts.find((y) => y.id === x.with)?.name || "?"} 계정의 대화): ${x.text}` : `- ${c.name}: ${x.text}`;
				if (line.length + 1 > left) break;
				memo.push(line);
				left -= line.length + 1;
			}
		}
		if (!rows.length && !memo.length) return "";
		rows.sort((a, b) => a.t - b.t);
		const parts = [];
		if (rows.length) parts.push(`[휴대폰 메신저 기록 - 오래된 순. 이 대화는 실제로 오갔다. 대화 당사자만 그 내용을 안다. 이야기에 자연스럽게 반영하되, 그대로 옮겨 적지 않는다.]\n${rows.slice(-INJECT_LINES).map((r) => r.line).join("\n")}`);
		if (memo.length) parts.push(`[메신저에서 생긴 일 - 해당 인물만 안다]\n${memo.join("\n")}`);
		return parts.join("\n\n");
	}
	async function injectMessengerNote(messages, type) {
		if (type !== "model" || messages.some((m) => String(m.content).includes(OWN_MARK))) return messages;
		try {
			const ctx = await currentPlace();
			if (!ctx) return messages;
			const state = await loadState(ctx.key);
			if (!state.enabled || !state.inject) return messages;
			const note = messengerNote(state, await parseCbs("{{user}}"));
			if (!note) return messages;
			let at = messages.length;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "user") {
					at = i;
					break;
				}
			}
			const next = messages.slice();
			next.splice(at, 0, {
				role: "system",
				content: note
			});
			globalThis.__interludeLastInject = {
				at,
				total: next.length,
				chars: note.length
			};
			return next;
		} catch (e) {
			console.log("[interlude] inject failed: " + e.message);
			void systemFailure("send", e, "inject failed");
			return messages;
		}
	}

//#endregion
//#region src/main.js
	(async () => {
		await risuai.registerButton({
			name: "Interlude",
			icon: `<img src="${ICON_URI}" width="20" height="20" alt="">`,
			iconType: "html",
			location: "chat",
			id: "interlude-open"
		}, openMessenger);
		await risuai.registerSetting("Interlude", openMessenger, `<img src="${ICON_URI}" width="20" height="20" alt="">`, "html", "interlude-settings");
		await risuai.registerSetting("Interlude 시스템 로그", openSystemLog, "📋", "html", "interlude-system-log");
		syncFab();
		await risuai.addRisuReplacer("beforeRequest", injectMessengerNote);
	})();

//#endregion
})();