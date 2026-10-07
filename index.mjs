import { foldSurface } from "@deepseek-ai/dsh-session";
//#region src/saved-user-messages.ts
function savedUserMessageSeq(event) {
	if (event.type !== "user/message" || typeof event.surfaceOp !== "object" || event.surfaceOp.op !== "replace") return void 0;
	const original = event.data.source.messageEdit?.originalEventSeq;
	return Number.isSafeInteger(original) && original >= 0 ? original : void 0;
}
/** 为聊天和历史操作还原用户可见文本；官方替换事件本身不增加聊天行。 */
function savedUserMessages(events) {
	const result = /* @__PURE__ */ new Map();
	for (const event of events) {
		const originalSeq = savedUserMessageSeq(event);
		if (originalSeq === void 0 || event.type !== "user/message") continue;
		const original = events[originalSeq];
		if (original?.type !== "user/message" || original.surfaceOp !== "append" || original.data.id !== event.data.id) continue;
		result.set(originalSeq, event);
	}
	return result;
}
function visibleUserEvents(events) {
	const saved = savedUserMessages(events);
	if (saved.size === 0) return events;
	return events.map((event) => {
		const replacement = saved.get(event.seq);
		return replacement === void 0 ? event : {
			...event,
			data: replacement.data
		};
	});
}
//#endregion
//#region src/build-info.ts
/** 由构建脚本生成；前后端共享同一份构建身份。 */
const MESSAGE_EDIT_BUILD_INFO = Object.freeze({
	"version": "0.3.0",
	"buildId": "952c32134401a88f10f7",
	"targetDshVersion": "0.2.0-rc.2"
});
//#endregion
//#region src/shared.ts
/** Same-origin endpoint owned by the Message Edit host plugin. */
const MESSAGE_EDIT_PATH = "/api/message-edit";
/** Timeline sits between Trajectory (10) and Prompt Studio (20). */
const MESSAGE_EDIT_VIEW_ORDER = 15;
/** Current durable event schema for structurally paired version effects. */
const MESSAGE_EDIT_VERSION_SCHEMA = 2;
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "message-edit";
/** Public services used by the branch transaction and timeline projection. */
const inject = [
	"sessions",
	"agents",
	"sessionPersistence",
	"sessionQuery",
	"workspaceRegistry",
	"connection"
];
function pairVersionEffect(sourceSessionId, effect) {
	return {
		schemaVersion: 2,
		effect: {
			...effect,
			id: crypto.randomUUID()
		},
		inverse: {
			kind: "restore-version",
			sessionId: sourceSessionId
		}
	};
}
function isTextualBlock(block) {
	return block?.type === "text" || block?.type === "reasoning";
}
function userText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function cloneUser(message, content = structuredClone(message.content)) {
	return Object.freeze({
		id: crypto.randomUUID(),
		role: "user",
		content: Object.freeze(content),
		source: Object.freeze({ kind: "user" })
	});
}
function replaceTextBlock(content, blockIndex, text) {
	const block = content[blockIndex];
	if (!isTextualBlock(block)) throw new Error("所选内容块不是可编辑文本。");
	return content.map((candidate, index) => index === blockIndex ? {
		...candidate,
		text
	} : structuredClone(candidate));
}
function isAttachmentBlock(block) {
	return block?.type === "image" || block?.type === "file";
}
/** 比较完整持久值，数组顺序有意义，对象属性顺序不构成修改。 */
function equalContentValue(left, right) {
	if (left === right) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalContentValue(value, right[index]));
	const a = left;
	const b = right;
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && equalContentValue(a[key], b[key]));
}
function replaceUserText(content, blockIndex, text) {
	if (content[blockIndex]?.type === "text") return replaceTextBlock(content, blockIndex, text);
	if (blockIndex === content.length && !content.some((block) => block.type === "text")) {
		if (text === "") return structuredClone(content);
		return [...structuredClone(content), {
			type: "text",
			text
		}];
	}
	throw new Error("所选用户消息块不是文本。");
}
function replaceUserAttachments(content, attachments) {
	const result = [];
	const lastAttachment = content.findLastIndex(isAttachmentBlock);
	let next = 0;
	for (const [index, block] of content.entries()) {
		if (!isAttachmentBlock(block)) result.push(structuredClone(block));
		else if (next < attachments.length) result.push(structuredClone(attachments[next++]));
		if (index === lastAttachment) {
			result.push(...structuredClone(attachments.slice(next)));
			next = attachments.length;
		}
	}
	if (lastAttachment < 0) result.push(...structuredClone(attachments));
	return result;
}
/** 先完成官方附件准入，再写消息；拒绝或上传失败不会留下半条编辑记录。 */
async function withEditedUserContent(ctx, agent, message, operation, applyContent) {
	let content = replaceUserText(message.content, operation.blockIndex, operation.text);
	const inputs = operation.attachments;
	const receiptIds = [];
	let fileUploads;
	if (inputs !== void 0) {
		const retained = /* @__PURE__ */ new Map();
		const admission = [];
		for (const [index, input] of inputs.entries()) if (input.type === "retained") {
			const block = message.content[input.blockIndex];
			if (!isAttachmentBlock(block)) throw new TypeError("保留的附件位置不存在或不是附件。");
			retained.set(index, structuredClone(block));
		} else if (input.type === "file") {
			fileUploads ??= ctx.get("fileUploads");
			if (fileUploads === void 0) throw new Error("宿主未提供文件上传服务。");
			const receiptId = input.receiptId;
			const attachment = fileUploads.resolve(agent, receiptId);
			if (attachment === void 0) throw new TypeError("文件上传凭据不存在、已失效或不属于当前会话。");
			admission.push({
				type: "file",
				attachment
			});
			if (!receiptIds.includes(receiptId)) receiptIds.push(receiptId);
		} else admission.push(input);
		const store = ctx.get("attachments");
		if (admission.length > 0 && store === void 0) throw new Error("宿主未提供附件存储服务。");
		const admitted = admission.length === 0 ? [] : await store.admitPromptContent(admission);
		let next = 0;
		const attachments = inputs.map((_input, index) => retained.get(index) ?? admitted[next++]);
		content = replaceUserAttachments(content, attachments);
		const images = attachments.filter((block) => block.type === "image");
		if (!equalContentValue(content, message.content) && store !== void 0 && (images.length > store.imageLimits.maxImagesPerMessage || images.reduce((bytes, block) => bytes + block.attachment.bytes, 0) > store.imageLimits.maxMessageImageBytes)) throw new Error("编辑后的图片数量或总大小超过宿主限制。");
	}
	if (!content.some((block) => isAttachmentBlock(block) || block.type === "text" && block.text.trim().length > 0)) throw new TypeError("用户消息需要正文或至少一个附件。");
	const requestId = crypto.randomUUID();
	const binding = receiptIds.length === 0 ? void 0 : fileUploads?.bindPrompt(agent, receiptIds, requestId);
	try {
		const result = await applyContent(content);
		binding?.commit();
		if (binding !== void 0) fileUploads?.retirePrompt(agent, requestId);
		return result;
	} finally {
		binding?.[Symbol.dispose]();
	}
}
/** Fold complete turn brackets; an open tail is deliberately absent. */
function closedTurns(events) {
	const result = [];
	let current;
	for (const event of events) {
		if (event.type === "turn/start") {
			current = {
				turn: event.data.turn,
				startSeq: event.seq,
				assistants: []
			};
			continue;
		}
		if (current === void 0) continue;
		if (event.type === "user/message" && current.user === void 0 && event.data.source.kind === "user") {
			current.user = event;
			continue;
		}
		if (event.type === "assistant/message" && event.data.turn === current.turn) {
			current.assistants.push(event);
			continue;
		}
		if (event.type === "turn/end" && event.data.turn === current.turn) {
			result.push({
				...current,
				endSeq: event.seq
			});
			current = void 0;
		}
	}
	return result;
}
function editableMessages(turns) {
	const result = [];
	for (const turn of turns) {
		if (turn.user !== void 0) {
			const content = structuredClone(turn.user.data.content);
			const attachments = content.flatMap((block, blockIndex) => isAttachmentBlock(block) ? [{
				blockIndex,
				content: block
			}] : []);
			const textBlocks = content.flatMap((block, blockIndex) => block.type === "text" ? [{
				blockIndex,
				text: block.text
			}] : []);
			if (textBlocks.length === 0 && attachments.length > 0) textBlocks.push({
				blockIndex: content.length,
				text: ""
			});
			for (const { blockIndex, text } of textBlocks) result.push({
				key: `${String(turn.user.seq)}:${String(blockIndex)}`,
				turn: turn.turn,
				eventSeq: turn.user.seq,
				blockIndex,
				kind: "user",
				text,
				time: turn.user.time,
				content,
				attachments
			});
		}
		for (const event of turn.assistants) for (const [blockIndex, block] of event.data.message.content.entries()) {
			if (!isTextualBlock(block)) continue;
			result.push({
				key: `${String(event.seq)}:${String(blockIndex)}`,
				turn: turn.turn,
				eventSeq: event.seq,
				blockIndex,
				kind: block.type === "reasoning" ? "assistant.reasoning" : "assistant.response",
				text: block.text,
				time: event.time
			});
		}
	}
	return result;
}
function retryableTurns(turns) {
	return turns.flatMap((turn) => turn.user === void 0 ? [] : [{
		turn: turn.turn,
		userEventSeq: turn.user.seq,
		preview: userText(turn.user.data),
		time: turn.user.time
	}]);
}
function downstreamUsers(turns, start) {
	return turns.slice(start).flatMap((turn) => turn.user === void 0 ? [] : [cloneUser(turn.user.data)]);
}
function assistantReplacement(event, blockIndex, text) {
	const replaced = replaceTextBlock(event.data.message.content, blockIndex, text).filter((block) => block.type === "text" || block.type === "reasoning");
	return Object.freeze({
		id: crypto.randomUUID(),
		role: "assistant",
		content: Object.freeze(replaced),
		source: Object.freeze({
			kind: "model",
			provider: event.data.message.source.provider,
			model: event.data.message.source.model
		})
	});
}
function editPlan(operation, turns, editedUserContent) {
	const turnIndex = turns.findIndex((turn) => operation.eventSeq > turn.startSeq && operation.eventSeq < turn.endSeq);
	const turn = turns[turnIndex];
	if (turn === void 0) throw new Error("所选消息不属于已落定回合。");
	const event = turn.user?.seq === operation.eventSeq ? turn.user : turn.assistants.find((candidate) => candidate.seq === operation.eventSeq);
	if (event === void 0) throw new Error("所选消息不存在或不可编辑。");
	if (event.type === "user/message") {
		const before = event.data.content[operation.blockIndex];
		const edited = cloneUser(event.data, editedUserContent ?? replaceUserText(event.data.content, operation.blockIndex, operation.text));
		const later = operation.cascade === "preserve" ? downstreamUsers(turns, turnIndex + 1) : [];
		return {
			boundary: turn.startSeq - 1,
			version: pairVersionEffect(operation.sessionId, {
				operation: "edit",
				cascade: operation.cascade,
				regenerate: true,
				targetTurn: turn.turn,
				targetEventSeq: event.seq,
				targetBlockIndex: operation.blockIndex,
				blockKind: "user",
				before: before?.type === "text" ? before.text : "",
				after: operation.text
			}),
			queuedUsers: [edited, ...later]
		};
	}
	const before = event.data.message.content[operation.blockIndex];
	if (!isTextualBlock(before)) throw new Error("所选助手消息块不是文本或思考。");
	const blockKind = before.type === "reasoning" ? "assistant.reasoning" : "assistant.response";
	if (turn.user === void 0) throw new Error("所选助手消息没有可重建的用户输入。");
	return {
		boundary: turn.startSeq - 1,
		version: pairVersionEffect(operation.sessionId, {
			operation: "edit",
			cascade: operation.cascade,
			targetTurn: turn.turn,
			targetEventSeq: event.seq,
			targetBlockIndex: operation.blockIndex,
			blockKind,
			before: before.text,
			after: operation.text
		}),
		manualTurn: {
			turn: turn.turn,
			user: cloneUser(turn.user.data),
			assistant: assistantReplacement(event, operation.blockIndex, operation.text)
		},
		queuedUsers: operation.cascade === "preserve" ? downstreamUsers(turns, turnIndex + 1) : []
	};
}
function retryPlan(sessionId, turnNumber, cascade, turns) {
	const turnIndex = turns.findIndex((turn) => turn.turn === turnNumber);
	const turn = turns[turnIndex];
	if (turn?.user === void 0) throw new Error("所选回合没有可重放的用户输入。");
	return {
		boundary: turn.startSeq - 1,
		version: pairVersionEffect(sessionId, {
			operation: "retry",
			cascade,
			targetTurn: turn.turn,
			targetEventSeq: turn.user.seq
		}),
		queuedUsers: cascade === "preserve" ? downstreamUsers(turns, turnIndex) : [cloneUser(turn.user.data)]
	};
}
function rerollPlan(sessionId, turns) {
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		const turn = turns[index];
		if (turn?.user === void 0) continue;
		const target = turn.assistants.findLast((event) => event.data.message.content.some(isTextualBlock));
		if (target === void 0) continue;
		return {
			boundary: turn.startSeq - 1,
			version: pairVersionEffect(sessionId, {
				operation: "reroll",
				cascade: "truncate",
				targetTurn: turn.turn,
				targetEventSeq: target.seq
			}),
			queuedUsers: [cloneUser(turn.user.data)]
		};
	}
	throw new Error("当前会话没有可重生成的已落定助手回复。");
}
function planOperation(operation, events, editedUserContent) {
	const turns = closedTurns(events);
	switch (operation.action) {
		case "edit": return editPlan(operation, turns, editedUserContent);
		case "reroll": return rerollPlan(operation.sessionId, turns);
		case "retry": return retryPlan(operation.sessionId, operation.turn, operation.cascade, turns);
	}
}
function agentOptions(events, fallback) {
	const config = events.findLast((event) => event.type === "request/header")?.data.header.config;
	const selected = lastModelSelection(events);
	const provider = selected?.provider ?? fallback?.provider;
	const model = selected?.model ?? fallback?.model;
	if (provider === void 0 || provider.length === 0 || model === void 0 || model.length === 0) throw new Error("无法从会话历史解析模型路由。");
	const maxTokens = config?.maxTokens ?? fallback?.maxTokens;
	const reasoningEffort = selected === void 0 ? fallback?.reasoningEffort : selected.reasoningEffort;
	return {
		provider,
		model,
		...maxTokens === void 0 ? {} : { maxTokens },
		...reasoningEffort === void 0 ? {} : { reasoningEffort }
	};
}
async function withSourceAgent(ctx, sessionId, operation) {
	let handle;
	let agent = ctx.agents.get(sessionId);
	if (agent === void 0) {
		const snapshot = await ctx.sessionQuery.readSession(sessionId);
		handle = await ctx.agents.resume({
			resumeSessionId: sessionId,
			agentOptions: agentOptions(snapshot.events),
			...await presetComposition(ctx, snapshot.session, snapshot.events)
		});
		agent = handle.agent;
	}
	try {
		return await agent.runMaintenance(async () => operation(agent));
	} finally {
		await handle?.dispose();
	}
}
function inheritedSeed(source, boundary) {
	if (boundary === -1) return [];
	const boundaryEvent = source[boundary];
	if (boundary < 0 || boundaryEvent === void 0 || boundaryEvent.seq !== boundary) throw new Error("分支边界不是连续会话事件。");
	return source.slice(0, boundary + 1);
}
/** Build seed envelopes locally; Session construction performs canonical validation and freezing. */
function appendLogSeedEvent(events, type, data) {
	events.push({
		type,
		seq: events.length,
		time: Date.now(),
		data,
		...type === "message-edit/version" ? { ignorable: true } : {}
	});
}
function appendSurfaceSeedEvent(events, type, data, intent) {
	events.push({
		type,
		seq: events.length,
		time: Date.now(),
		data,
		surfaceOp: intent.surfaceOp,
		...intent.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: intent.sourceEventSeqs }
	});
}
function appendManualTurn(events, manual) {
	const { turn, user, assistant } = manual;
	appendLogSeedEvent(events, "turn/start", { turn });
	appendSurfaceSeedEvent(events, "user/message", user, { surfaceOp: "append" });
	appendLogSeedEvent(events, "step/start", {
		turn,
		step: 1
	});
	appendSurfaceSeedEvent(events, "assistant/message", {
		turn,
		step: 1,
		message: assistant,
		stream: []
	}, { surfaceOp: "append" });
	appendLogSeedEvent(events, "step/end", {
		turn,
		step: 1
	});
	appendLogSeedEvent(events, "turn/end", {
		turn,
		reason: { kind: "completed" }
	});
}
function versionSeed(source, plan, projections) {
	const events = inheritedSeed(source, plan.boundary);
	const inheritedLength = events.length;
	const saved = savedUserMessages(source);
	const inheritedSaved = savedUserMessages(events);
	const nodes = saved.size === 0 ? [] : foldSurface(events, projections).nodes;
	appendLogSeedEvent(events, "session/end-seed", { inherited: true });
	for (const [originalSeq, latest] of saved) {
		const original = events[originalSeq];
		if (originalSeq >= inheritedLength || original?.type !== "user/message") continue;
		const current = inheritedSaved.get(originalSeq) ?? original;
		if (latest.seq === current.seq || !nodes.includes(current.seq)) continue;
		appendSurfaceSeedEvent(events, "user/message", latest.data, {
			surfaceOp: {
				op: "replace",
				startSeq: current.seq,
				endSeq: current.seq
			},
			sourceEventSeqs: [current.seq]
		});
	}
	const pending = {
		"next-turn": 0,
		"next-step": 0
	};
	for (const event of events) {
		if (event.type !== "agent/inbox/spliced") continue;
		pending[event.data.target] += event.data.inserted.length - (event.data.removedCount ?? 0);
	}
	for (const target of ["next-step", "next-turn"]) {
		if (pending[target] === 0) continue;
		appendLogSeedEvent(events, "agent/inbox/spliced", {
			target,
			start: 0,
			removedCount: pending[target],
			inserted: [],
			outcome: "canceled"
		});
	}
	appendLogSeedEvent(events, "message-edit/version", plan.version);
	if (plan.manualTurn !== void 0) appendManualTurn(events, plan.manualTurn);
	return {
		events,
		inheritedLength
	};
}
function sessionPreset(header, events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "agent-preset/selected") return event.data.agentPreset;
	}
	return header.agentPreset;
}
async function presetComposition(ctx, header, events = []) {
	const presets = ctx.get("agentPresets");
	const presetId = sessionPreset(header, events);
	if (presets === void 0) {
		if (presetId !== void 0) throw new Error("会话所用的 Agent preset 服务不可用。");
		return {};
	}
	const resolved = (await presets.resolve(presetId)).id;
	return {
		agentPreset: resolved,
		setup: async (agentCtx) => {
			await presets.mount(agentCtx, resolved);
		}
	};
}
async function createVersionAgent(ctx, source, sourceEvents, childId, plan, options, settings) {
	const seed = versionSeed(sourceEvents, plan, ctx.sessions.messageProjections);
	const { agentPreset, setup } = await presetComposition(ctx, source.header, sourceEvents);
	const child = await ctx.agents.create({
		sessionId: childId,
		seed: seed.events,
		inheritedEventCount: seed.inheritedLength,
		meta: {
			...source.header.cwd === void 0 ? {} : { cwd: source.header.cwd },
			parentSession: source.id,
			isSeeded: true,
			...agentPreset === void 0 ? {} : { agentPreset }
		},
		agentOptions: options,
		...setup === void 0 ? {} : { setup }
	});
	try {
		await applySettings(ctx, child.agent, settings);
		await ctx.sessions.flush(child.agent.session);
		return child;
	} catch (error) {
		await child.dispose();
		throw error;
	}
}
function sourceWorkspace(ctx, sessionId) {
	return ctx.workspaceRegistry.list().find((workspace) => workspace.sessionIds.includes(sessionId));
}
function sessionController(ctx) {
	const controller = ctx.get("sessionController");
	if (controller === void 0) throw new Error("当前 DSH 未提供公开会话控制接口。");
	return controller;
}
function permissions(ctx) {
	return ctx.get("permissionPresets");
}
function lastModelSelection(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "model/selection") return event.data;
		if (event?.type === "request/header") {
			const config = event.data.header.config;
			if (config.provider === void 0 || config.model === void 0) continue;
			return {
				provider: config.provider,
				model: config.model,
				...config.reasoningEffort === void 0 || event.data.header.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort: config.reasoningEffort }
			};
		}
	}
}
function lastPermissionPreset(events) {
	for (const entry of [...events].reverse()) {
		const event = entry;
		if (event.type === "permission/preset" && typeof event.data.preset === "string") return event.data.preset;
	}
}
async function composerOptions(ctx, sessionId, signal) {
	const controller = sessionController(ctx);
	const [snapshot, catalog, projected] = await Promise.all([
		ctx.sessionQuery.readSession(sessionId),
		controller.modelCatalog(),
		controller.projections({ sessionId }, signal)
	]);
	const permissionCatalog = permissions(ctx)?.catalog();
	const selected = projected?.values.modelSelection?.next ?? lastModelSelection(snapshot.events) ?? catalog.default;
	const permissionValue = projected?.values["permissions"];
	const currentPreset = typeof permissionValue === "object" && permissionValue !== null && !Array.isArray(permissionValue) && typeof permissionValue["currentValue"] === "string" ? permissionValue["currentValue"] : lastPermissionPreset(snapshot.events) ?? permissionCatalog?.defaultPreset;
	return {
		current: {
			...selected,
			...currentPreset === void 0 ? {} : { permissionPreset: currentPreset }
		},
		models: catalog.groups.flatMap((group) => group.models.map((model) => ({
			provider: group.id,
			providerLabel: group.name,
			model: model.id,
			label: model.name,
			reasoningEfforts: model.reasoning?.efforts.map((effort) => effort.id) ?? [],
			...model.reasoning === void 0 ? {} : { reasoningEffortLabels: Object.fromEntries(model.reasoning.efforts.map((effort) => [effort.id, effort.name])) }
		}))),
		permissions: permissionCatalog?.options.map((option) => ({
			id: option.value,
			label: option.name,
			...option.description === void 0 ? {} : { description: option.description }
		})) ?? []
	};
}
/** 校验配置草稿时只读目录，附件准入或正文校验失败不会修改会话设置。 */
async function validateSettings(ctx, settings) {
	if (settings === void 0) return;
	if (settings.provider !== void 0 && settings.model !== void 0) {
		const model = (await sessionController(ctx).modelCatalog()).groups.find((group) => group.id === settings.provider)?.models.find((model) => model.id === settings.model);
		if (model === void 0) throw new TypeError("所选模型当前不可用。");
		if (settings.reasoningEffort !== void 0 && !model.reasoning?.efforts.some((effort) => effort.id === settings.reasoningEffort)) throw new TypeError("所选模型不支持该推理强度。");
	}
	if (settings.permissionPreset !== void 0) {
		const permission = permissions(ctx);
		if (permission === void 0) throw new Error("当前 DSH 未提供权限预设。");
		if (!permission.catalog().options.some((option) => option.value === settings.permissionPreset)) throw new TypeError("所选权限预设当前不可用。");
		permission.resolve(settings.permissionPreset);
	}
}
/** 只在确认操作后调用与正常输入框一致的公开切换路径。 */
async function applySettings(ctx, agent, settings) {
	if (settings === void 0) return;
	if (settings.provider !== void 0 && settings.model !== void 0) await sessionController(ctx).selectModel({
		sessionId: agent.id,
		provider: settings.provider,
		model: settings.model,
		...settings.reasoningEffort === void 0 ? {} : { reasoningEffort: settings.reasoningEffort }
	});
	if (settings.permissionPreset !== void 0) permissions(ctx)?.set(agent.session, settings.permissionPreset);
}
/** 模型选择省略推理强度表示恢复模型默认值；权限省略则保留原值。 */
async function changedSettings(ctx, sessionId, settings) {
	if (settings === void 0 || Object.keys(settings).length === 0) return void 0;
	const current = (await composerOptions(ctx, sessionId, new AbortController().signal)).current;
	const changed = {};
	if (settings.provider !== void 0 && settings.model !== void 0 && (settings.provider !== current.provider || settings.model !== current.model || settings.reasoningEffort !== current.reasoningEffort)) {
		changed.provider = settings.provider;
		changed.model = settings.model;
		if (settings.reasoningEffort !== void 0) changed.reasoningEffort = settings.reasoningEffort;
	}
	if (settings.permissionPreset !== void 0 && settings.permissionPreset !== current.permissionPreset) changed.permissionPreset = settings.permissionPreset;
	return Object.keys(changed).length === 0 ? void 0 : changed;
}
async function liveAgent(ctx, sessionId) {
	const existing = ctx.agents.get(sessionId);
	if (existing !== void 0) return existing;
	const result = await sessionController(ctx).resolveAgent(sessionId);
	if ("error" in result) throw result.error;
	return result.agent;
}
async function references(ctx, sessionId, query, signal) {
	const service = ctx.get("fileReferences");
	if (service === void 0) return [];
	return (await service.list(await liveAgent(ctx, sessionId), query, signal)).map((candidate) => ({
		path: candidate.path,
		label: candidate.path,
		kind: candidate.kind === "directory" ? "folder" : "file"
	}));
}
async function openAttachment(ctx, sessionId, eventSeq, blockIndex, signal) {
	const snapshot = await ctx.sessionQuery.readSession(sessionId);
	const original = snapshot.events.find((event) => event.seq === eventSeq);
	if (original?.type !== "user/message") throw new TypeError("所选消息不存在。");
	const block = (savedUserMessages(snapshot.events).get(original.seq) ?? original).data.content[blockIndex];
	if (block?.type !== "file") throw new TypeError("所选附件不是当前消息中的文件。");
	const path = ctx.get("attachments")?.fileHostPath(block.attachment);
	if (path === void 0) throw new Error("当前附件存储不支持在系统应用中打开文件。");
	await sessionController(ctx).openWorkspacePath({ path }, signal);
}
async function openUpload(ctx, sessionId, receiptId, signal) {
	const agent = await liveAgent(ctx, sessionId);
	const uploads = ctx.get("fileUploads");
	if (uploads === void 0) throw new Error("当前 DSH 未提供文件上传服务。");
	const attachment = uploads.resolve(agent, receiptId);
	if (attachment === void 0) throw new TypeError("文件上传凭据不属于当前会话或已失效。");
	const path = ctx.get("attachments")?.fileHostPath(attachment);
	if (path === void 0) throw new Error("当前附件存储不支持在系统应用中打开文件。");
	await sessionController(ctx).openWorkspacePath({ path }, signal);
}
async function openReference(ctx, sessionId, path, signal) {
	const snapshot = await ctx.sessionQuery.readSession(sessionId);
	const fs = ctx.get("fs");
	if (fs === void 0) throw new Error("当前 DSH 未提供文件系统服务。");
	const target = await fs.resolve(path, {
		...snapshot.session.cwd === void 0 ? {} : { cwd: snapshot.session.cwd },
		signal
	});
	await sessionController(ctx).openWorkspacePath({ path: fs.processPath(target) }, signal);
}
async function recoverOperation(inverses) {
	const failures = [];
	for (const inverse of inverses.reverse()) try {
		await inverse();
	} catch (error) {
		failures.push(error);
	}
	if (failures.length > 0) throw new AggregateError(failures, "版本操作恢复失败。");
}
async function runOperation(ctx, operation) {
	const sourceId = sessionIdOf(operation.sessionId);
	if (operation.action === "save" || operation.action === "edit" && operation.regenerate === false) return saveUserMessage(ctx, sourceId, operation);
	if (operation.action === "edit" && operation.settings === void 0 && operation.attachments === void 0 && ctx.agents.get(sourceId) === void 0) {
		const { events } = await ctx.sessionQuery.readSession(sourceId);
		const plan = planOperation(operation, visibleUserEvents(events));
		if (plan.manualTurn !== void 0 && plan.version.effect.before === plan.version.effect.after) return {
			sessionId: sourceId,
			queuedTurns: 0,
			unchanged: true
		};
	}
	return withSourceAgent(ctx, sourceId, async (source) => {
		const events = (await ctx.sessionQuery.readSession(sourceId)).events;
		const visible = visibleUserEvents(events);
		const settings = operation.action === "edit" ? operation.settings : void 0;
		if (operation.action === "edit" && settings !== void 0 && !closedTurns(visible).some((turn) => turn.user?.seq === operation.eventSeq)) throw new TypeError("只有用户消息可以设置模型和权限。");
		await validateSettings(ctx, settings);
		const perform = async (editedUserContent) => {
			const childId = sessionIdOf(`session-${crypto.randomUUID()}`);
			const inverses = [];
			try {
				const plan = planOperation(operation, visible, editedUserContent);
				if (plan.manualTurn !== void 0 && plan.version.effect.before === plan.version.effect.after) return {
					sessionId: sourceId,
					queuedTurns: 0,
					unchanged: true
				};
				const options = agentOptions(events, source.options);
				const child = await createVersionAgent(ctx, source.session, events, childId, plan, options, settings);
				inverses.push(() => child.dispose());
				const workspace = sourceWorkspace(ctx, sourceId);
				if (workspace !== void 0) {
					await workspace.attachSession(childId);
					inverses.push(() => workspace.detachSession(childId));
				}
				for (const message of plan.queuedUsers) child.agent.followup(message);
				inverses.length = 0;
				return {
					sessionId: childId,
					queuedTurns: plan.queuedUsers.length
				};
			} catch (error) {
				try {
					await recoverOperation(inverses);
				} catch (recoveryError) {
					throw new AggregateError([error, recoveryError], "版本操作及其恢复均失败。");
				}
				throw error;
			}
		};
		if (operation.action === "edit") {
			const user = closedTurns(visible).find((turn) => turn.user?.seq === operation.eventSeq)?.user;
			if (user !== void 0) return withEditedUserContent(ctx, source, user.data, operation, perform);
			if (operation.attachments !== void 0) throw new TypeError("只有用户消息可以编辑附件。");
		}
		return perform();
	});
}
async function saveUserMessage(ctx, sourceId, operation) {
	if (ctx.agents.get(sourceId) === void 0) {
		const { events } = await ctx.sessionQuery.readSession(sourceId);
		const original = closedTurns(events).find((turn) => turn.user?.seq === operation.eventSeq)?.user;
		if (original !== void 0) {
			const current = savedUserMessages(events).get(original.seq) ?? original;
			let content = replaceUserText(current.data.content, operation.blockIndex, operation.text);
			if (operation.attachments !== void 0) {
				const retained = [];
				for (const input of operation.attachments) {
					if (input.type !== "retained") {
						content = void 0;
						break;
					}
					const block = current.data.content[input.blockIndex];
					if (!isAttachmentBlock(block)) throw new TypeError("保留的附件位置不存在或不是附件。");
					retained.push(block);
				}
				if (content !== void 0) content = replaceUserAttachments(content, retained);
			}
			if (content !== void 0 && equalContentValue(content, current.data.content) && foldSurface(events, ctx.sessions.messageProjections).nodes.includes(current.seq)) {
				await validateSettings(ctx, operation.settings);
				if (await changedSettings(ctx, sourceId, operation.settings) === void 0) return {
					sessionId: sourceId,
					queuedTurns: 0,
					saved: true,
					unchanged: true
				};
			}
		}
	}
	return withSourceAgent(ctx, sourceId, async (source) => {
		const events = (await ctx.sessionQuery.readSession(sourceId)).events;
		const original = closedTurns(events).find((candidate) => candidate.user?.seq === operation.eventSeq)?.user;
		if (original === void 0) throw new Error("所选用户消息不存在或回合尚未结束。");
		const current = savedUserMessages(events).get(original.seq) ?? original;
		if (!source.session.surface.nodes.includes(current.seq)) throw new Error("该消息已不在当前模型上下文中，无法在当前会话保存；可以使用“保存并发送”创建新版本。");
		return withEditedUserContent(ctx, source, current.data, operation, async (content) => {
			await validateSettings(ctx, operation.settings);
			const settings = await changedSettings(ctx, sourceId, operation.settings);
			const contentChanged = !equalContentValue(content, current.data.content);
			if (!contentChanged && settings === void 0) return {
				sessionId: sourceId,
				queuedTurns: 0,
				saved: true,
				unchanged: true
			};
			await applySettings(ctx, source, settings);
			const messageSource = {
				...current.data.source,
				messageEdit: { originalEventSeq: original.seq }
			};
			if (contentChanged) source.session.append("user/message", {
				...current.data,
				content,
				source: messageSource
			}, {
				surfaceOp: {
					op: "replace",
					startSeq: current.seq,
					endSeq: current.seq
				},
				sourceEventSeqs: [current.seq]
			});
			await ctx.sessions.flush(source.session);
			return {
				sessionId: sourceId,
				queuedTurns: 0,
				saved: true
			};
		});
	});
}
function ownVersionEvent(header, events, inherited) {
	const ownEvents = events.filter((event) => event.type === "message-edit/version" && event.seq >= inherited);
	if (ownEvents.length === 0) return void 0;
	if (ownEvents.length > 1) throw new Error(`会话 ${header.id} 包含多个自身版本效果。`);
	const event = ownEvents[0];
	if (event === void 0) return void 0;
	const parent = header.parentSession;
	if ("schemaVersion" in event.data) {
		const version = event.data;
		if (version.schemaVersion !== 2) throw new Error(`会话 ${header.id} 使用不支持的版本效果结构。`);
		if (version.inverse.kind !== "restore-version" || parent === void 0 || version.inverse.sessionId !== parent) throw new Error(`会话 ${header.id} 的版本效果与逆不匹配。`);
		return {
			effect: version.effect,
			inverseSessionId: version.inverse.sessionId,
			time: event.time
		};
	}
	const legacy = event.data;
	if (parent === void 0 || legacy.sourceSessionId !== parent) throw new Error(`会话 ${header.id} 的旧版恢复目标与父版本不匹配。`);
	return {
		effect: {
			id: `legacy:${header.id}:${String(event.seq)}`,
			operation: legacy.operation,
			cascade: legacy.cascade,
			targetTurn: legacy.targetTurn,
			targetEventSeq: legacy.targetEventSeq,
			...legacy.targetBlockIndex === void 0 ? {} : { targetBlockIndex: legacy.targetBlockIndex },
			...legacy.blockKind === void 0 ? {} : { blockKind: legacy.blockKind },
			...legacy.before === void 0 ? {} : { before: legacy.before },
			...legacy.after === void 0 ? {} : { after: legacy.after }
		},
		inverseSessionId: legacy.sourceSessionId,
		time: event.time
	};
}
function flattenLineage(root, descendants) {
	const result = [{
		record: root,
		depth: 0
	}];
	const visit = (nodes, depth) => {
		const ordered = [...nodes].sort((left, right) => left.session.header.createdAt - right.session.header.createdAt || String(left.session.header.id).localeCompare(String(right.session.header.id)));
		for (const node of ordered) {
			result.push({
				record: node.session,
				depth
			});
			visit(node.descendants, depth + 1);
		}
	};
	visit(descendants, 1);
	return result;
}
/** Bounded parallel inspection of persisted branches; matches the corpus worker shape. */
const TIMELINE_READ_CONCURRENCY = 4;
async function mapConcurrent(items, worker) {
	const results = new Array(items.length);
	let cursor = 0;
	const run = async () => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			if (index >= items.length) return;
			results[index] = await worker(items[index]);
		}
	};
	const workers = Math.min(TIMELINE_READ_CONCURRENCY, items.length);
	await Promise.all(Array.from({ length: workers }, () => run()));
	return results;
}
async function timeline(ctx, sessionId) {
	const targetTrace = await ctx.sessionQuery.traceSession(sessionId);
	const rootId = targetTrace.complete ? targetTrace.root.header.id : targetTrace.ancestors.at(-1)?.header.id ?? sessionId;
	const rootTrace = rootId === sessionId ? targetTrace : await ctx.sessionQuery.traceSession(rootId);
	const lineage = flattenLineage(rootTrace.target, rootTrace.descendants);
	const logs = await mapConcurrent(lineage, async ({ record }) => {
		if (record.header.id !== sessionId && record.header.parentSession === void 0) return {
			events: [],
			inheritedEventCount: 0
		};
		return ctx.sessionQuery.readSession(record.header.id);
	});
	const recordsById = new Map(lineage.map(({ record }) => [record.header.id, record]));
	const currentPath = /* @__PURE__ */ new Set();
	let pathId = sessionId;
	while (pathId !== void 0 && !currentPath.has(pathId)) {
		currentPath.add(pathId);
		pathId = recordsById.get(pathId)?.header.parentSession;
	}
	const versions = lineage.map(({ record, depth }, index) => {
		const log = logs[index];
		const version = ownVersionEvent(record.header, log?.events ?? [], log?.inheritedEventCount ?? 0);
		return {
			sessionId: record.header.id,
			...record.header.parentSession === void 0 ? {} : { parentSessionId: record.header.parentSession },
			...version === void 0 ? {} : {
				effectId: version.effect.id,
				inverseSessionId: version.inverseSessionId
			},
			createdAt: version?.time ?? record.header.createdAt,
			depth,
			current: record.header.id === sessionId,
			onCurrentEffectPath: currentPath.has(record.header.id),
			...version === void 0 ? {} : {
				operation: version.effect.operation,
				cascade: version.effect.cascade,
				targetTurn: version.effect.targetTurn,
				...version.effect.blockKind === void 0 ? {} : { blockKind: version.effect.blockKind },
				...version.effect.before === void 0 ? {} : { before: version.effect.before },
				...version.effect.after === void 0 ? {} : { after: version.effect.after }
			}
		};
	});
	const effectIds = /* @__PURE__ */ new Set();
	for (const version of versions) {
		if (version.effectId === void 0) continue;
		if (effectIds.has(version.effectId)) throw new Error(`版本效果 ${version.effectId} 重复。`);
		effectIds.add(version.effectId);
	}
	const versionsById = new Map(versions.map((version) => [version.sessionId, version]));
	const undoStack = [];
	let undoCursor = versionsById.get(sessionId);
	while (undoCursor?.inverseSessionId !== void 0) {
		const inverseId = undoCursor.inverseSessionId;
		if (undoStack.includes(inverseId)) throw new Error("版本效果逆链包含循环。");
		if (!versionsById.has(inverseId)) throw new Error(`恢复目标 ${inverseId} 不在可见版本树中。`);
		undoStack.push(inverseId);
		undoCursor = versionsById.get(inverseId);
	}
	const redoSessionIds = versions.filter((version) => version.inverseSessionId === sessionId).map((version) => version.sessionId);
	const currentIndex = versions.findIndex((version) => version.current);
	const currentLog = logs[currentIndex];
	if (currentIndex < 0 || currentLog === void 0) throw new Error("当前版本不在版本树中。");
	const turns = closedTurns(visibleUserEvents(currentLog.events));
	return {
		sessionId,
		build: MESSAGE_EDIT_BUILD_INFO,
		messages: editableMessages(turns),
		retryableTurns: retryableTurns(turns),
		versions,
		undoStack,
		redoSessionIds
	};
}
function objectValue(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("请求体必须是 JSON 对象。");
	return value;
}
function sessionIdOf(value) {
	if (typeof value !== "string" || value.length === 0) throw new TypeError("sessionId 必须是非空字符串。");
	return value;
}
function integerOf(value, name) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} 必须是非负安全整数。`);
	return value;
}
function cascadeOf(value) {
	if (value !== "truncate" && value !== "preserve") throw new TypeError("cascade 必须是 truncate 或 preserve。");
	return value;
}
function attachmentsOf(value) {
	if (value === void 0) return void 0;
	if (!Array.isArray(value)) throw new TypeError("attachments 必须是数组。");
	return value.map((input) => {
		const attachment = objectValue(input);
		switch (attachment["type"]) {
			case "retained": return {
				type: "retained",
				blockIndex: integerOf(attachment["blockIndex"], "附件 blockIndex")
			};
			case "file":
				if (typeof attachment["receiptId"] !== "string" || attachment["receiptId"].length === 0) throw new TypeError("文件附件需要有效的 receiptId。");
				return {
					type: "file",
					receiptId: attachment["receiptId"]
				};
			case "image": {
				const mediaType = attachment["mediaType"];
				if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp" && mediaType !== "image/gif") throw new TypeError("图片格式必须是 PNG、JPEG、WebP 或 GIF。");
				if (typeof attachment["data"] !== "string" || attachment["data"].length === 0) throw new TypeError("图片附件需要上传字节，不能直接提交持久引用。");
				if (attachment["name"] !== void 0 && typeof attachment["name"] !== "string") throw new TypeError("附件 name 必须是字符串。");
				return {
					type: "image",
					mediaType,
					data: attachment["data"],
					...attachment["name"] === void 0 ? {} : { name: attachment["name"] }
				};
			}
			default: throw new TypeError("附件必须是已有附件位置、图片上传或文件上传凭据。");
		}
	});
}
function nonEmptyString(value, name) {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new TypeError(`${name} 必须是非空字符串。`);
	return value;
}
function settingsOf(value) {
	if (value === void 0) return void 0;
	const settings = objectValue(value);
	const provider = settings["provider"] === void 0 ? void 0 : nonEmptyString(settings["provider"], "provider");
	const model = settings["model"] === void 0 ? void 0 : nonEmptyString(settings["model"], "model");
	if (provider === void 0 !== (model === void 0)) throw new TypeError("provider 和 model 必须同时提供。");
	const effort = settings["reasoningEffort"] === void 0 ? void 0 : nonEmptyString(settings["reasoningEffort"], "reasoningEffort");
	if (effort !== void 0 && model === void 0) throw new TypeError("推理强度必须与模型一起提供。");
	return {
		...provider === void 0 ? {} : { provider },
		...model === void 0 ? {} : { model },
		...effort === void 0 ? {} : { reasoningEffort: effort },
		...settings["permissionPreset"] === void 0 ? {} : { permissionPreset: nonEmptyString(settings["permissionPreset"], "permissionPreset") }
	};
}
function decodeOperation(value) {
	const record = objectValue(value);
	const sessionId = sessionIdOf(record["sessionId"]);
	const attachments = attachmentsOf(record["attachments"]);
	const settings = settingsOf(record["settings"]);
	switch (record["action"]) {
		case "save":
			if (typeof record["text"] !== "string") throw new TypeError("text 必须是字符串。");
			return {
				action: "save",
				sessionId,
				eventSeq: integerOf(record["eventSeq"], "eventSeq"),
				blockIndex: integerOf(record["blockIndex"], "blockIndex"),
				text: record["text"],
				...attachments === void 0 ? {} : { attachments },
				...settings === void 0 ? {} : { settings }
			};
		case "edit":
			if (typeof record["text"] !== "string") throw new TypeError("text 必须是字符串。");
			if (record["regenerate"] !== void 0 && typeof record["regenerate"] !== "boolean") throw new TypeError("regenerate 必须是布尔值。");
			return {
				action: "edit",
				sessionId,
				eventSeq: integerOf(record["eventSeq"], "eventSeq"),
				blockIndex: integerOf(record["blockIndex"], "blockIndex"),
				text: record["text"],
				cascade: cascadeOf(record["cascade"]),
				...record["regenerate"] === void 0 ? {} : { regenerate: record["regenerate"] },
				...attachments === void 0 ? {} : { attachments },
				...settings === void 0 ? {} : { settings }
			};
		case "reroll": return {
			action: "reroll",
			sessionId
		};
		case "retry": return {
			action: "retry",
			sessionId,
			turn: integerOf(record["turn"], "turn"),
			cascade: cascadeOf(record["cascade"])
		};
		default: throw new TypeError("action 必须是 save、edit、reroll 或 retry。");
	}
}
function respondJson(status, value) {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store" }
	});
}
/** 提供节点身份及完整替换窗口，不返回正文，供其他插件解析修订链。 */
async function revisions(ctx, sessionId) {
	const { events } = await ctx.sessionQuery.readSession(sessionId);
	const saved = savedUserMessages(events);
	const surface = foldSurface(events, ctx.sessions.messageProjections);
	return {
		schemaVersion: 1,
		sessionId,
		revisions: [...saved.entries()].map(([originalEventSeq, replacement]) => ({
			originalEventSeq,
			replacementEventSeq: replacement.seq,
			revisionEventSeqs: events.filter((event) => savedUserMessageSeq(event) === originalEventSeq).map((event) => event.seq),
			active: surface.nodes.includes(replacement.seq)
		})),
		replacements: surface.replacements.map((entry) => ({
			replacementEventSeq: entry.seq,
			startSeq: entry.start,
			endSeq: entry.end,
			shadowedEventSeqs: entry.shadowedSeqs
		}))
	};
}
async function handleRoute(ctx, request, recent) {
	let action = "unknown";
	try {
		if (request.method === "GET") {
			const query = new URL(request.url).searchParams;
			if (query.get("view") === "diagnostics") return respondJson(200, {
				schemaVersion: 1,
				build: MESSAGE_EDIT_BUILD_INFO,
				recent: [...recent]
			});
			const sessionId = sessionIdOf(query.get("sessionId"));
			if (query.get("view") === "revisions") return respondJson(200, await revisions(ctx, sessionId));
			if (query.get("view") === "options") return respondJson(200, await composerOptions(ctx, sessionId, request.signal));
			if (query.get("view") === "references") return respondJson(200, await references(ctx, sessionId, query.get("query") ?? "", request.signal));
			return respondJson(200, await timeline(ctx, sessionId));
		}
		if (request.method === "POST") {
			let value;
			try {
				value = await request.json();
			} catch {
				throw new TypeError("请求体必须是有效的 JSON。");
			}
			const record = objectValue(value);
			if ([
				"save",
				"edit",
				"reroll",
				"retry",
				"open-attachment",
				"open-upload",
				"open-reference"
			].includes(String(record["action"]))) action = String(record["action"]);
			const sessionId = sessionIdOf(record["sessionId"]);
			if (record["action"] === "open-attachment") {
				await openAttachment(ctx, sessionId, integerOf(record["eventSeq"], "eventSeq"), integerOf(record["blockIndex"], "blockIndex"), request.signal);
				return respondJson(200, { opened: true });
			}
			if (record["action"] === "open-upload") {
				await openUpload(ctx, sessionId, nonEmptyString(record["receiptId"], "receiptId"), request.signal);
				return respondJson(200, { opened: true });
			}
			if (record["action"] === "open-reference") {
				await openReference(ctx, sessionId, nonEmptyString(record["path"], "path"), request.signal);
				return respondJson(200, { opened: true });
			}
			const result = await runOperation(ctx, decodeOperation(value));
			recent.push({
				time: Date.now(),
				action,
				status: 200,
				...result.unchanged === true ? { unchanged: true } : {}
			});
			if (recent.length > 40) recent.shift();
			return respondJson(200, result);
		}
		return new Response(null, { status: 405 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = error instanceof TypeError ? 400 : 409;
		if (request.method === "POST") {
			recent.push({
				time: Date.now(),
				action,
				status,
				code: error instanceof TypeError ? "invalid-request" : "operation-failed"
			});
			if (recent.length > 40) recent.shift();
		}
		return respondJson(status, { error: message });
	}
}
/** 通过宿主通信层注册路由，复用桌面端和浏览器的认证与传输。 */
function apply(ctx) {
	const connection = ctx.get("connection");
	const recent = [];
	connection.fetch.register({
		path: MESSAGE_EDIT_PATH,
		methods: ["GET", "POST"],
		requestBody: "buffered",
		fetch: (request) => handleRoute(ctx, request, recent)
	});
}
//#endregion
export { MESSAGE_EDIT_BUILD_INFO, MESSAGE_EDIT_PATH, MESSAGE_EDIT_VERSION_SCHEMA, MESSAGE_EDIT_VIEW_ORDER, apply, inject, name };
