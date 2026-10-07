window.__ModuleLoader__.load({
	id: "@sh1robana/dsh-plugin-message-edit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/shared.ts
		/** Same-origin endpoint owned by the Message Edit host plugin. */
		const MESSAGE_EDIT_PATH = "/api/message-edit";
		//#endregion
		//#region src/client/transport.ts
		/** 使用页面提供的宿主传输，兼容桌面端的自定义协议和普通 Web 页面。 */
		function hostFetch(input, init) {
			const globals = globalThis;
			const path = input.replace(/^\//, "");
			const transport = globals.__DSH_TRANSPORT__;
			return transport?.fetch !== void 0 ? transport.fetch(path, init) : globalThis.fetch(path, init);
		}
		//#endregion
		//#region src/saved-user-messages.ts
		function savedUserMessageSeq(event) {
			if (event.type !== "user/message" || typeof event.surfaceOp !== "object" || event.surfaceOp.op !== "replace") return void 0;
			const original = event.data.source.messageEdit?.originalEventSeq;
			return Number.isSafeInteger(original) && original >= 0 ? original : void 0;
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
		//#region src/client/attachmentTools.ts
		function attachmentTools(ctx, sessionId) {
			const conversation = () => {
				const service = ctx.get("conversation");
				if (service === void 0) throw new Error("DSH 附件服务尚未就绪，请重启后重试。");
				return service;
			};
			return {
				create: (files) => conversation().createDrafts(sessionId, files),
				serialize: async (ids) => (await conversation().serializeDraftAttachments(ids)).attachments,
				release: (id) => {
					conversation().releaseDraftAttachment(id);
				},
				retry: (id) => {
					conversation().retryFileUpload(sessionId, id);
				},
				uploads: () => conversation().fileUploads.getSnapshot(),
				subscribe: (listener) => conversation().fileUploads.subscribe(listener),
				imageUrl: (attachment) => ctx.uiConversation.imageUrl(sessionId, attachment)
			};
		}
		//#endregion
		//#region src/client/composerTools.ts
		async function readResponse(response) {
			const value = await response.json();
			if (!response.ok) throw new Error(value.error ?? `请求失败：HTTP ${String(response.status)}`);
			return value;
		}
		function composerTools(ctx, sessionId) {
			const get = async (query, signal) => {
				return readResponse(await hostFetch(`${MESSAGE_EDIT_PATH}?${new URLSearchParams({
					sessionId,
					...query
				})}`, {
					method: "GET",
					cache: "no-store",
					...signal === void 0 ? {} : { signal }
				}));
			};
			const post = async (operation) => {
				await readResponse(await hostFetch(MESSAGE_EDIT_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						sessionId,
						...operation
					})
				}));
			};
			return {
				options: async () => await get({ view: "options" }),
				references: async (query, signal) => {
					const remote = ctx.get("remote");
					const [files, sessions] = await Promise.all([get({
						view: "references",
						query
					}, signal), remote?.sessionReferenceResolver?.candidates(sessionId, query, signal)]);
					return [...files, ...sessions?.ok ? sessions.value.map((item) => ({
						...item,
						kind: "session"
					})) : []];
				},
				openPath: (path) => post({
					action: "open-reference",
					path
				}),
				openSession: (id) => {
					ctx.uiWorkspace.openSession(id);
				},
				openAttachment: (eventSeq, blockIndex) => post({
					action: "open-attachment",
					eventSeq,
					blockIndex
				}),
				openUpload: (receiptId) => post({
					action: "open-upload",
					receiptId
				}),
				commands: async (query, signal) => {
					const commands = ctx.get("commandUi");
					return commands === void 0 ? [] : commands.candidates({ sessionId }, {
						query,
						position: "leading",
						signal
					});
				},
				command: async (line) => {
					const commands = ctx.get("commandUi");
					if (commands !== void 0) {
						const result = await commands.execute({ sessionId }, line);
						if (result.kind === "error") throw new Error(result.text);
						return;
					}
					const session = ctx.get("sessions").binding(sessionId)?.session;
					if (session === void 0) throw new Error("当前会话尚未就绪，请稍后重试。");
					const result = await session.command(line);
					if (!result.ok) throw new Error(result.error.message);
					if (!result.value.matched) throw new Error("当前 DSH 未提供此指令。");
				}
			};
		}
		//#endregion
		//#region src/client/controller.ts
		/** 合并回合完成时的后台刷新，不延迟首次加载。 */
		const REFRESH_DELAY_MS = 300;
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}
		function objectValue(value, label) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} 不是对象`);
			return value;
		}
		function stringValue(value, label) {
			if (typeof value !== "string") throw new TypeError(`${label} 不是字符串`);
			return value;
		}
		function numberValue(value, label) {
			if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} 不是数字`);
			return value;
		}
		function booleanValue(value, label) {
			if (typeof value !== "boolean") throw new TypeError(`${label} 不是布尔值`);
			return value;
		}
		function blockKind(value) {
			if (value !== "user" && value !== "assistant.reasoning" && value !== "assistant.response") throw new TypeError("消息块类型无效");
			return value;
		}
		function decodeMessage(value, index) {
			const row = objectValue(value, `messages[${String(index)}]`);
			return {
				key: stringValue(row["key"], "消息 key"),
				turn: numberValue(row["turn"], "消息 turn"),
				eventSeq: numberValue(row["eventSeq"], "消息 eventSeq"),
				blockIndex: numberValue(row["blockIndex"], "消息 blockIndex"),
				kind: blockKind(row["kind"]),
				text: stringValue(row["text"], "消息 text"),
				time: numberValue(row["time"], "消息 time"),
				...row["content"] === void 0 ? {} : { content: arrayValue(row["content"], "消息 content") },
				...row["attachments"] === void 0 ? {} : { attachments: arrayValue(row["attachments"], "消息 attachments") }
			};
		}
		function decodeRetryable(value, index) {
			const row = objectValue(value, `retryableTurns[${String(index)}]`);
			return {
				turn: numberValue(row["turn"], "回合 turn"),
				userEventSeq: numberValue(row["userEventSeq"], "回合 userEventSeq"),
				preview: stringValue(row["preview"], "回合 preview"),
				time: numberValue(row["time"], "回合 time")
			};
		}
		function optionalOperation(value) {
			if (value === void 0) return void 0;
			if (value === "edit" || value === "reroll" || value === "retry") return value;
			throw new TypeError("版本 operation 无效");
		}
		function decodeVersion(value, index) {
			const row = objectValue(value, `versions[${String(index)}]`);
			const operation = optionalOperation(row["operation"]);
			const cascade = row["cascade"];
			if (cascade !== void 0 && cascade !== "truncate" && cascade !== "preserve") throw new TypeError("版本 cascade 无效");
			const kind = row["blockKind"] === void 0 ? void 0 : blockKind(row["blockKind"]);
			return {
				sessionId: stringValue(row["sessionId"], "版本 sessionId"),
				...row["parentSessionId"] === void 0 ? {} : { parentSessionId: stringValue(row["parentSessionId"], "版本 parentSessionId") },
				...row["effectId"] === void 0 ? {} : { effectId: stringValue(row["effectId"], "版本 effectId") },
				...row["inverseSessionId"] === void 0 ? {} : { inverseSessionId: stringValue(row["inverseSessionId"], "版本 inverseSessionId") },
				createdAt: numberValue(row["createdAt"], "版本 createdAt"),
				depth: numberValue(row["depth"], "版本 depth"),
				current: booleanValue(row["current"], "版本 current"),
				onCurrentEffectPath: booleanValue(row["onCurrentEffectPath"], "版本 onCurrentEffectPath"),
				...operation === void 0 ? {} : { operation },
				...cascade === void 0 ? {} : { cascade },
				...row["targetTurn"] === void 0 ? {} : { targetTurn: numberValue(row["targetTurn"], "版本 targetTurn") },
				...kind === void 0 ? {} : { blockKind: kind },
				...row["before"] === void 0 ? {} : { before: stringValue(row["before"], "版本 before") },
				...row["after"] === void 0 ? {} : { after: stringValue(row["after"], "版本 after") }
			};
		}
		function arrayValue(value, label) {
			if (!Array.isArray(value)) throw new TypeError(`${label} 不是数组`);
			return value;
		}
		function stringArray(value, label) {
			return arrayValue(value, label).map((item, index) => stringValue(item, `${label}[${String(index)}]`));
		}
		function decodeTimeline(value) {
			const data = objectValue(value, "Timeline 响应");
			return {
				sessionId: stringValue(data["sessionId"], "Timeline sessionId"),
				messages: arrayValue(data["messages"], "Timeline messages").map(decodeMessage),
				retryableTurns: arrayValue(data["retryableTurns"], "Timeline retryableTurns").map(decodeRetryable),
				versions: arrayValue(data["versions"], "Timeline versions").map(decodeVersion),
				undoStack: stringArray(data["undoStack"], "Timeline undoStack"),
				redoSessionIds: stringArray(data["redoSessionIds"], "Timeline redoSessionIds")
			};
		}
		function decodeOperationResult(value) {
			const data = objectValue(value, "操作响应");
			return {
				sessionId: stringValue(data["sessionId"], "操作 sessionId"),
				queuedTurns: numberValue(data["queuedTurns"], "操作 queuedTurns"),
				...data["saved"] === void 0 ? {} : { saved: booleanValue(data["saved"], "操作 saved") },
				...data["unchanged"] === void 0 ? {} : { unchanged: booleanValue(data["unchanged"], "操作 unchanged") }
			};
		}
		async function responseValue(response) {
			const value = await response.json();
			if (response.ok) return value;
			const error = objectValue(value, "错误响应")["error"];
			throw new Error(typeof error === "string" ? error : `请求失败：HTTP ${String(response.status)}`);
		}
		function conversationRevision(snapshot) {
			const changes = snapshot.entries.flatMap((entry) => {
				if (entry.type !== "event") return [];
				if (entry.event.type === "turn/end") return [`turn:${String(entry.event.data.turn)}:${String(entry.event.seq)}`];
				if (savedUserMessageSeq(entry.event) !== void 0) return [`save:${String(entry.event.seq)}`];
				return [];
			});
			return [snapshot.hasMore, changes.join(",")].join("|");
		}
		function lineageRevision(snapshot, sessionId) {
			let root = sessionId;
			const ancestorIds = /* @__PURE__ */ new Set();
			while (!ancestorIds.has(root)) {
				ancestorIds.add(root);
				const parent = snapshot.byId[root]?.parentId;
				if (parent === void 0 || snapshot.byId[parent] === void 0) break;
				root = parent;
			}
			const connected = [];
			for (const rawId of Object.keys(snapshot.byId).sort()) {
				const id = rawId;
				const seen = /* @__PURE__ */ new Set();
				let cursor = id;
				while (cursor !== void 0 && !seen.has(cursor)) {
					if (cursor === root) {
						connected.push(`${id}>${snapshot.byId[id]?.parentId ?? ""}`);
						break;
					}
					seen.add(cursor);
					cursor = snapshot.byId[cursor]?.parentId;
				}
			}
			return connected.join("|");
		}
		/** One stable controller is shared by all entries mounted for the same session. */
		var MessageEditController = class {
			sessionId;
			store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				status: "idle",
				error: null,
				pending: null,
				timeline: null
			});
			face;
			generation = 0;
			ctx;
			sessions;
			sessionSource;
			sessionSourceDispose;
			sessionRevision;
			listRevision = "";
			refreshScheduled = false;
			refreshTimer;
			observing = false;
			disposeObservation = void 0;
			inflight = null;
			rerunAfter = false;
			abort = null;
			disposed = false;
			users = 0;
			constructor(ctx, sessionId) {
				this.sessionId = sessionId;
				this.ctx = ctx;
				this.sessions = ctx.get("sessions");
				this.face = {
					hooks: { messageEdit: this.store },
					acquire: () => {
						this.users += 1;
						if (this.users === 1 && this.disposed) this.revive();
						return () => this.release();
					},
					load: () => {
						const status = this.store.getSnapshot().status;
						if (status === "idle" || status === "error") this.load();
					},
					attachmentTools: attachmentTools(ctx, this.sessionId),
					composerTools: composerTools(ctx, this.sessionId),
					edit: (message, text, cascade, regenerate = true, attachments, settings) => this.mutate(message.kind === "user" && !regenerate ? {
						action: "save",
						sessionId: this.sessionId,
						eventSeq: message.eventSeq,
						blockIndex: message.blockIndex,
						text,
						...attachments === void 0 ? {} : { attachments },
						...settings === void 0 ? {} : { settings }
					} : {
						action: "edit",
						sessionId: this.sessionId,
						eventSeq: message.eventSeq,
						blockIndex: message.blockIndex,
						text,
						cascade,
						regenerate,
						...attachments === void 0 ? {} : { attachments },
						...settings === void 0 ? {} : { settings }
					}),
					retry: (turn, cascade) => this.mutate({
						action: "retry",
						sessionId: this.sessionId,
						turn,
						cascade
					}),
					reroll: () => this.mutate({
						action: "reroll",
						sessionId: this.sessionId
					}),
					openVersion: (sessionId) => this.openWhenListed(sessionId)
				};
				this.observe();
			}
			observe() {
				this.disposeObservation = this.ctx.effect(() => this.observeDependencies(), `message-edit: observe ${this.sessionId}`);
			}
			release() {
				this.users -= 1;
				if (this.users <= 0) this.dispose();
			}
			/** Tear subscriptions down once no mounted entry uses this controller. */
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.generation += 1;
				if (this.refreshTimer !== void 0) {
					clearTimeout(this.refreshTimer);
					this.refreshTimer = void 0;
					this.refreshScheduled = false;
				}
				this.abort?.abort();
				this.abort = null;
				this.disposeObservation?.();
				this.disposeObservation = void 0;
			}
			/** Re-observe after a transient zero; the retained store keeps old data
			* until the immediate refetch below commits. */
			revive() {
				this.disposed = false;
				this.observe();
				this.refresh();
			}
			/** Bind to replaceable value sources instead of retaining a Session object. */
			observeDependencies() {
				this.observing = true;
				this.listRevision = lineageRevision(this.sessions.list.getSnapshot(), this.sessionId);
				this.bindSessionSource();
				const disposeList = this.sessions.list.subscribe(() => {
					const rebound = this.bindSessionSource();
					const nextRevision = lineageRevision(this.sessions.list.getSnapshot(), this.sessionId);
					if (nextRevision === this.listRevision && !rebound) return;
					this.listRevision = nextRevision;
					this.invalidate();
				});
				return () => {
					this.observing = false;
					this.generation += 1;
					disposeList();
					this.sessionSourceDispose?.();
					this.sessionSourceDispose = void 0;
					this.sessionSource = void 0;
					this.sessionRevision = void 0;
				};
			}
			bindSessionSource() {
				const source = this.sessions.binding(this.sessionId)?.eventSource;
				if (source === this.sessionSource) return false;
				this.sessionSourceDispose?.();
				this.sessionSource = source;
				this.sessionRevision = source === void 0 ? void 0 : conversationRevision(source.getSnapshot());
				this.sessionSourceDispose = source?.subscribe(() => {
					if (this.sessionSource !== source) return;
					const revision = conversationRevision(source.getSnapshot());
					if (revision === this.sessionRevision) return;
					this.sessionRevision = revision;
					this.invalidate();
				});
				return true;
			}
			invalidate() {
				if (!this.observing || this.store.getSnapshot().status === "idle" || this.refreshScheduled) return;
				this.refreshScheduled = true;
				this.refreshTimer = setTimeout(() => {
					this.refreshTimer = void 0;
					this.refreshScheduled = false;
					if (this.observing && this.store.getSnapshot().status !== "idle") this.refresh();
				}, REFRESH_DELAY_MS);
			}
			/** Invalidation-driven refetch: one in-flight request absorbs the demand
			* and commits a single rerun once it settles. */
			refresh() {
				if (this.disposed) return;
				if (this.inflight !== null) {
					this.rerunAfter = true;
					return;
				}
				this.load();
			}
			/** Refetch the full value-level projection; concurrent callers share one
			* request, and an invalidation during flight schedules exactly one rerun. */
			async load() {
				if (this.disposed) return;
				if (this.inflight !== null) return this.inflight;
				const generation = ++this.generation;
				this.abort?.abort();
				const abort = new AbortController();
				this.abort = abort;
				this.store.update((state) => {
					if (state.status !== "ready") state.status = "loading";
					state.error = null;
				});
				const run = this.performLoad(generation, abort);
				this.inflight = run;
				try {
					await run;
				} finally {
					if (this.inflight === run) this.inflight = null;
					if (this.rerunAfter && !this.disposed) {
						this.rerunAfter = false;
						this.load();
					}
				}
			}
			async performLoad(generation, abort) {
				try {
					const value = await responseValue(await hostFetch(`${MESSAGE_EDIT_PATH}?sessionId=${encodeURIComponent(this.sessionId)}`, {
						method: "GET",
						headers: { accept: "application/json" },
						cache: "no-store",
						signal: abort.signal
					}));
					const build = objectValue(value, "Timeline 响应")["build"];
					if (build !== void 0) {
						const identity = objectValue(build, "宿主构建");
						if (identity["version"] !== MESSAGE_EDIT_BUILD_INFO.version || identity["buildId"] !== MESSAGE_EDIT_BUILD_INFO.buildId) throw new Error("消息编辑插件的前后端版本不一致，请彻底退出 DSH 后重新启动；浏览器页面请刷新。");
					}
					const timeline = decodeTimeline(value);
					if (generation !== this.generation) return;
					this.store.update((state) => {
						state.status = "ready";
						state.error = null;
						state.timeline = timeline;
					});
				} catch (error) {
					if (generation !== this.generation) return;
					this.store.update((state) => {
						state.status = "error";
						state.error = messageOf(error);
					});
				}
			}
			/** Refresh only controllers whose projection has already been requested. */
			refreshIfLoaded() {
				if (this.disposed || this.store.getSnapshot().status === "idle") return;
				this.refresh();
			}
			async mutate(operation) {
				const current = this.store.getSnapshot();
				if (current.pending !== null || current.status !== "ready") return false;
				this.store.update((state) => {
					state.pending = operation.action === "save" ? "edit" : operation.action;
					state.error = null;
				});
				try {
					const result = decodeOperationResult(await responseValue(await hostFetch(MESSAGE_EDIT_PATH, {
						method: "POST",
						headers: {
							accept: "application/json",
							"content-type": "application/json"
						},
						body: JSON.stringify(operation)
					})));
					if (result.unchanged === true && (result.sessionId !== this.sessionId || result.queuedTurns !== 0)) throw new Error("宿主未确认无修改保存，请更新插件并重启 DSH。");
					if (operation.action === "save" && (result.sessionId !== this.sessionId || result.queuedTurns !== 0 || result.saved !== true)) throw new Error("宿主未确认在当前会话保存，请更新插件并彻底重启 DSH。");
					if (!this.disposed && result.unchanged !== true) if (operation.action === "save") {
						if (this.inflight !== null) {
							this.rerunAfter = true;
							await this.load();
						}
						await this.load();
					} else await this.openWhenListed(result.sessionId);
					this.store.update((state) => {
						state.pending = null;
					});
					return true;
				} catch (error) {
					this.store.update((state) => {
						state.pending = null;
						if (!this.disposed) state.error = messageOf(error);
					});
					return false;
				}
			}
			/** 通过新版工作区导航持有会话引用，并同步切换主视图。 */
			async openWhenListed(sessionId) {
				if (this.disposed) return;
				await this.sessions.refresh();
				if (!this.disposed) this.ctx.uiWorkspace.openSession(sessionId);
			}
		};
		//#endregion
		//#region \0dsh-css:D:\ai\home\codex\dsh-message-edit\src\client\InlineMessageEdit.module.css.mjs
		const css$2 = ".jW03kW_overlay,.jW03kW_composer{--message-edit-panel:#fafbfc;--message-edit-hover:#eef0f3;--message-edit-border:#dce0e7;--message-edit-text:#1d2430;--message-edit-secondary:#687487;--message-edit-danger:#c62828;--message-edit-link:#406bf0;color:var(--message-edit-text);color-scheme:light}body[data-ds-dark-theme] .jW03kW_overlay,body[data-ds-dark-theme] .jW03kW_composer{--message-edit-panel:#25272b;--message-edit-hover:#33363d;--message-edit-border:#494d56;--message-edit-text:#eef0f5;--message-edit-secondary:#b0b7c4;--message-edit-danger:#ff8e8e;--message-edit-link:#8da9ff;color-scheme:dark}.jW03kW_overlay{z-index:1000;background:var(--dsw-alias-bg-mask,#00000073);box-sizing:border-box;justify-content:center;align-items:center;padding:24px;display:flex;position:fixed;inset:0}.jW03kW_panel{box-sizing:border-box;border:1px solid var(--message-edit-border);background:var(--message-edit-panel);border-radius:10px;width:min(960px,100%);max-height:calc(100dvh - 48px);padding:20px 24px;overflow:auto}.jW03kW_title{color:var(--message-edit-text);padding:4px 0 10px;font-size:15px}.jW03kW_input{box-sizing:border-box;border:1px solid var(--message-edit-border);background:var(--message-edit-panel);width:100%;height:min(52dvh,560px);min-height:min(320px,40dvh);max-height:calc(100dvh - 180px);color:var(--message-edit-text);font:inherit;resize:vertical;border-radius:8px;padding:10px;line-height:1.6}.jW03kW_footer{flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:10px 0 0;display:flex}.jW03kW_footer button{border:1px solid var(--message-edit-border);background:var(--message-edit-hover);color:var(--message-edit-text);cursor:pointer;border-radius:6px;padding:6px 14px}.jW03kW_footer button:disabled{cursor:wait;opacity:.6}.jW03kW_attachmentEditor{padding:0 0 10px}.jW03kW_attachmentList{flex-wrap:wrap;gap:10px;max-height:180px;display:flex;overflow:auto}.jW03kW_attachmentList:empty{display:none}.jW03kW_attachmentCard{box-sizing:border-box;border:1px solid var(--message-edit-border);width:240px;min-height:72px;color:var(--message-edit-text);background:var(--message-edit-panel);border-radius:8px;align-items:center;gap:10px;padding:8px 30px 8px 8px;display:flex;position:relative}.jW03kW_attachmentPreview{object-fit:contain;width:64px;height:64px;color:var(--message-edit-secondary);background:var(--message-edit-hover);border-radius:6px;flex:0 0 64px;justify-content:center;align-items:center;font-size:12px;display:flex}.jW03kW_attachmentInfo{flex-direction:column;gap:4px;min-width:0;font-size:13px;display:flex}.jW03kW_attachmentInfo>span:first-child{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.jW03kW_attachmentStatus{color:var(--message-edit-secondary);overflow-wrap:anywhere;font-size:11px}.jW03kW_attachmentRemove{background:var(--message-edit-hover);width:22px;height:22px;color:var(--message-edit-text);cursor:pointer;border:none;border-radius:50%;padding:0;font-size:18px;position:absolute;top:4px;right:4px}.jW03kW_attachmentRemove:disabled{opacity:.5;cursor:wait}.jW03kW_attachmentAdd{border:1px solid var(--message-edit-border);background:var(--message-edit-hover);color:var(--message-edit-text);cursor:pointer;border-radius:6px;margin:8px 0 0;padding:6px 10px}.jW03kW_footer .jW03kW_attachmentAdd{margin:0 auto 0 0}.jW03kW_attachmentNotice{color:var(--message-edit-danger);padding-top:4px;font-size:12px}.jW03kW_attachmentNotice:empty{display:none}.jW03kW_confirmationOverlay{z-index:1001}.jW03kW_confirmPanel{box-sizing:border-box;border:1px solid var(--message-edit-border);background:var(--message-edit-panel);border-radius:10px;width:min(400px,100%);padding:20px 24px}@media (width<=600px){.jW03kW_overlay{padding:12px}.jW03kW_panel{max-height:calc(100dvh - 24px);padding:16px}}.jW03kW_iconButton{width:20px;height:20px;color:var(--message-edit-secondary);cursor:pointer;background:0 0;border:none;border-radius:4px;justify-content:center;align-items:center;padding:2px;display:inline-flex}.jW03kW_iconButton:hover{color:var(--message-edit-text);background:var(--message-edit-hover)}.jW03kW_picker{flex-direction:column;gap:6px;padding:4px 0 12px;display:flex}.jW03kW_pickerItem{border:1px solid var(--message-edit-border);background:var(--message-edit-hover);color:var(--message-edit-text);text-align:left;cursor:pointer;border-radius:6px;padding:8px 10px;font-size:12px}.jW03kW_pickerItem:hover{background:var(--message-edit-panel)}.jW03kW_pickerItemActive{border:1px solid var(--message-edit-border);background:var(--message-edit-hover);color:var(--message-edit-text);cursor:pointer;border-radius:6px;align-self:flex-end;padding:6px 14px}.jW03kW_composer{border:1px solid var(--message-edit-border);background:var(--message-edit-panel);border-radius:20px;padding:14px 16px 10px;position:relative}.jW03kW_composer:focus-within{border-color:var(--dsw-alias-brand-primary,#4d77f5)}.jW03kW_richInput{white-space:pre-wrap;overflow-wrap:anywhere;resize:none;border:none;border-radius:0;outline:none;height:min(42dvh,500px);min-height:min(250px,32dvh);padding:8px 0;overflow:auto}.jW03kW_richInput:empty:before{content:attr(data-placeholder);color:var(--message-edit-secondary);pointer-events:none}.jW03kW_fileReference{color:var(--message-edit-link);cursor:pointer;white-space:pre-wrap;border-radius:4px;padding:0 2px;display:inline}.jW03kW_fileReference:hover{background:var(--message-edit-hover)}.jW03kW_composerToolbar{flex-wrap:wrap;align-items:center;gap:8px;padding-top:8px;display:flex}.jW03kW_composerToolbar button{color:var(--message-edit-secondary);font:inherit;cursor:pointer;background:0 0;border:none}.jW03kW_composerToolbar button:hover{background:var(--message-edit-hover)}.jW03kW_composerToolbar .jW03kW_composerPlus{background:var(--message-edit-hover);border-radius:50%;width:34px;height:34px;padding:0;font-size:24px;line-height:1}.jW03kW_composerControl,.jW03kW_composerModel{border-radius:8px;padding:6px 8px;font-size:13px}.jW03kW_composerModel{overflow-wrap:anywhere;max-width:70%;margin-left:auto}.jW03kW_composerMenu,.jW03kW_referenceSuggestions{z-index:2;border:1px solid var(--message-edit-border);background:var(--message-edit-panel);border-radius:14px;max-height:min(44dvh,400px);padding:8px;position:absolute;bottom:52px;left:12px;right:12px;overflow:auto;box-shadow:0 4px 20px #0001}.jW03kW_composerMenu[hidden],.jW03kW_referenceSuggestions[hidden]{display:none}.jW03kW_composerMenu button,.jW03kW_referenceSuggestions button{width:100%;color:var(--message-edit-text);font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:8px;justify-content:space-between;align-items:center;gap:16px;padding:9px 10px;font-size:13px;display:flex}.jW03kW_composerMenu button:hover,.jW03kW_referenceSuggestions button:hover,.jW03kW_referenceSuggestions button[aria-selected=true]{background:var(--message-edit-hover)}.jW03kW_composerMenu .jW03kW_menuValue{color:var(--message-edit-secondary);text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:12px;overflow:hidden}.jW03kW_composerMenu[data-kind=permission],.jW03kW_composerMenu[data-kind=model],.jW03kW_composerMenu[data-kind=modelList]{box-sizing:border-box;border-radius:16px;width:min(320px,100% - 32px);padding:6px;left:auto;right:16px}.jW03kW_composerMenu[data-kind=permission]{width:min(220px,100% - 70px);left:54px;right:auto}.jW03kW_composerMenu[data-kind=modelList]{max-height:none;overflow:hidden}.jW03kW_composerMenu[data-kind=permission] button,.jW03kW_composerMenu[data-kind=model] button,.jW03kW_composerMenu[data-kind=modelList] button{white-space:nowrap;min-height:38px;padding:8px 10px;font-size:14px;overflow:hidden}.jW03kW_composerMenu button[role=menuitemradio] .jW03kW_menuValue{color:var(--message-edit-text);text-align:right;flex:0 0 16px}.jW03kW_composerMenu .jW03kW_menuBack{min-height:28px;color:var(--message-edit-secondary);font-size:12px}.jW03kW_menuItemLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.jW03kW_composerMenu button[role=menuitemradio] .jW03kW_menuItemLabel{flex:1}.jW03kW_composerMenu .jW03kW_modelSearch{border:none;outline:none;padding:8px 10px;font-size:14px}.jW03kW_modelSearch:focus-visible{box-shadow:inset 0 0 0 1px var(--message-edit-border)}.jW03kW_modelList{max-height:min(38dvh,280px);overflow-y:auto}.jW03kW_composerMenu input{box-sizing:border-box;border:1px solid var(--message-edit-border);background:inherit;width:100%;color:var(--message-edit-text);font:inherit;border-radius:8px;padding:10px}.jW03kW_menuHeading{color:var(--message-edit-secondary);padding:8px 10px 4px;font-size:12px}.jW03kW_attachmentAdd.jW03kW_attachmentAddCircle{border-radius:50%;width:34px;height:34px;padding:0;font-size:24px;line-height:1}.jW03kW_attachmentOpen{width:100%;min-width:0;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:10px;padding:0;display:flex}.jW03kW_attachmentOpen[data-kind=image]{cursor:zoom-in}.jW03kW_attachmentOpen:disabled{cursor:wait}.jW03kW_attachmentOpen:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d77f5);outline-offset:3px;border-radius:6px}.jW03kW_attachmentLightbox{z-index:1100;box-sizing:border-box;background:#000000d6;justify-content:center;align-items:center;padding:40px;display:flex;position:fixed;inset:0}.jW03kW_attachmentOriginal{object-fit:contain;width:auto;max-width:100%;height:auto;max-height:100%;display:block}.jW03kW_attachmentPreviewClose{color:#fff;cursor:pointer;background:#ffffff29;border:none;border-radius:50%;justify-content:center;align-items:center;width:36px;height:36px;padding:0;font-size:28px;display:flex;position:absolute;top:14px;right:18px}.jW03kW_attachmentPreviewClose:focus-visible{outline-offset:3px;outline:2px solid #fff}";
		const tagId$2 = "@sh1robana/dsh-plugin-message-edit/InlineMessageEdit.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@sh1robana/dsh-plugin-message-edit";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var InlineMessageEdit_module_css_default = {
			"input": "jW03kW_input",
			"attachmentInfo": "jW03kW_attachmentInfo",
			"attachmentStatus": "jW03kW_attachmentStatus",
			"menuBack": "jW03kW_menuBack",
			"attachmentOpen": "jW03kW_attachmentOpen",
			"composerPlus": "jW03kW_composerPlus",
			"attachmentOriginal": "jW03kW_attachmentOriginal",
			"title": "jW03kW_title",
			"menuItemLabel": "jW03kW_menuItemLabel",
			"attachmentCard": "jW03kW_attachmentCard",
			"pickerItemActive": "jW03kW_pickerItemActive",
			"attachmentAddCircle": "jW03kW_attachmentAddCircle",
			"attachmentLightbox": "jW03kW_attachmentLightbox",
			"picker": "jW03kW_picker",
			"attachmentPreview": "jW03kW_attachmentPreview",
			"menuValue": "jW03kW_menuValue",
			"referenceSuggestions": "jW03kW_referenceSuggestions",
			"attachmentRemove": "jW03kW_attachmentRemove",
			"overlay": "jW03kW_overlay",
			"pickerItem": "jW03kW_pickerItem",
			"footer": "jW03kW_footer",
			"confirmPanel": "jW03kW_confirmPanel",
			"composer": "jW03kW_composer",
			"modelSearch": "jW03kW_modelSearch",
			"attachmentEditor": "jW03kW_attachmentEditor",
			"fileReference": "jW03kW_fileReference",
			"attachmentNotice": "jW03kW_attachmentNotice",
			"menuHeading": "jW03kW_menuHeading",
			"panel": "jW03kW_panel",
			"iconButton": "jW03kW_iconButton",
			"attachmentPreviewClose": "jW03kW_attachmentPreviewClose",
			"confirmationOverlay": "jW03kW_confirmationOverlay",
			"composerMenu": "jW03kW_composerMenu",
			"attachmentList": "jW03kW_attachmentList",
			"composerControl": "jW03kW_composerControl",
			"modelList": "jW03kW_modelList",
			"richInput": "jW03kW_richInput",
			"composerToolbar": "jW03kW_composerToolbar",
			"composerModel": "jW03kW_composerModel",
			"attachmentAdd": "jW03kW_attachmentAdd"
		};
		//#endregion
		//#region src/client/confirmCancelEdit.ts
		/** 确认取消时保留原编辑器，只有选择“是”才提交关闭操作。 */
		function confirmCancelEdit(onConfirm, onReject) {
			const overlay = document.createElement("div");
			overlay.className = `${InlineMessageEdit_module_css_default["overlay"] ?? ""} ${InlineMessageEdit_module_css_default["confirmationOverlay"] ?? ""}`;
			const panel = document.createElement("div");
			panel.className = InlineMessageEdit_module_css_default["confirmPanel"] ?? "";
			panel.setAttribute("role", "alertdialog");
			panel.setAttribute("aria-modal", "true");
			panel.setAttribute("aria-label", "是否确认取消编辑");
			const title = document.createElement("div");
			title.className = InlineMessageEdit_module_css_default["title"] ?? "";
			title.textContent = "是否确认取消编辑";
			const footer = document.createElement("div");
			footer.className = InlineMessageEdit_module_css_default["footer"] ?? "";
			const yes = document.createElement("button");
			yes.type = "button";
			yes.textContent = "是";
			const no = document.createElement("button");
			no.type = "button";
			no.textContent = "否";
			footer.append(yes, no);
			panel.append(title, footer);
			overlay.appendChild(panel);
			document.body.appendChild(overlay);
			let mounted = true;
			const dispose = () => {
				if (!mounted) return;
				mounted = false;
				yes.removeEventListener("click", confirm);
				no.removeEventListener("click", reject);
				overlay.removeEventListener("keydown", onKeyDown);
				overlay.remove();
			};
			const confirm = () => {
				if (!mounted) return;
				dispose();
				onConfirm();
			};
			const reject = () => {
				if (!mounted) return;
				dispose();
				onReject();
			};
			const onKeyDown = (event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					reject();
				} else if (event.key === "Tab") {
					event.preventDefault();
					if (document.activeElement === no) yes.focus();
					else no.focus();
				}
			};
			yes.addEventListener("click", confirm);
			no.addEventListener("click", reject);
			overlay.addEventListener("keydown", onKeyDown);
			no.focus();
			return dispose;
		}
		//#endregion
		//#region src/client/AttachmentEditor.tsx
		function sizeLabel(bytes) {
			if (bytes < 1024) return `${String(bytes)} B`;
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
			return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		}
		/** 两种编辑入口共享附件草稿，关闭编辑器时仅释放新增附件。 */
		function mountAttachmentEditor(container, initial, tools, onBusy, actions, options = {}) {
			const items = initial.map((existing) => ({ existing }));
			const list = document.createElement("div");
			list.className = InlineMessageEdit_module_css_default["attachmentList"] ?? "";
			list.setAttribute("aria-label", "消息附件");
			const add = document.createElement("button");
			add.type = "button";
			add.className = `${InlineMessageEdit_module_css_default["attachmentAdd"] ?? ""} ${InlineMessageEdit_module_css_default["attachmentAddCircle"] ?? ""}`;
			add.textContent = "＋";
			add.setAttribute("aria-label", "添加附件");
			add.title = "添加图片或文件；替换附件时，先移除原附件再添加新文件。";
			const picker = document.createElement("input");
			picker.type = "file";
			picker.multiple = true;
			picker.hidden = true;
			picker.setAttribute("aria-label", "选择消息附件");
			const notice = document.createElement("div");
			notice.className = InlineMessageEdit_module_css_default["attachmentNotice"] ?? "";
			notice.setAttribute("role", "alert");
			if (actions === void 0) container.append(list, ...options.hideAdd ? [] : [add], picker, notice);
			else {
				container.append(list, notice);
				actions.prepend(...options.hideAdd ? [] : [add], picker);
			}
			let disposed = false;
			let disabled = false;
			let unsubscribe;
			const imageUrls = /* @__PURE__ */ new Map();
			let previewItem;
			let previewRevision = 0;
			let dismissPreview;
			const closePreview = () => {
				previewRevision += 1;
				previewItem = void 0;
				dismissPreview?.();
				dismissPreview = void 0;
			};
			const imageUrl = (existing) => {
				if (existing.content.type !== "image") throw new Error("此附件不是图片。");
				let url = imageUrls.get(existing.blockIndex);
				if (url === void 0) {
					url = tools.imageUrl(existing.content.attachment);
					imageUrls.set(existing.blockIndex, url);
					url.catch(() => {
						if (imageUrls.get(existing.blockIndex) === url) imageUrls.delete(existing.blockIndex);
					});
				}
				return url;
			};
			const showPreview = (src, name, item) => {
				closePreview();
				previewItem = item;
				const previousFocus = document.activeElement;
				const overlay = document.createElement("div");
				overlay.className = InlineMessageEdit_module_css_default["attachmentLightbox"] ?? "";
				overlay.setAttribute("role", "dialog");
				overlay.setAttribute("aria-modal", "true");
				overlay.setAttribute("aria-label", "图片预览");
				const image = document.createElement("img");
				image.className = InlineMessageEdit_module_css_default["attachmentOriginal"] ?? "";
				image.src = src;
				image.alt = name;
				const close = document.createElement("button");
				close.type = "button";
				close.className = InlineMessageEdit_module_css_default["attachmentPreviewClose"] ?? "";
				close.textContent = "×";
				close.setAttribute("aria-label", "关闭图片预览");
				const outside = (event) => {
					if (event.target === overlay) closePreview();
				};
				const key = (event) => {
					if (event.key !== "Escape" && event.key !== "Tab") return;
					event.preventDefault();
					event.stopPropagation();
					if (event.key === "Escape") closePreview();
					else close.focus();
				};
				overlay.append(image, close);
				overlay.addEventListener("click", outside);
				close.addEventListener("click", closePreview);
				document.addEventListener("keydown", key, true);
				dismissPreview = () => {
					document.removeEventListener("keydown", key, true);
					overlay.removeEventListener("click", outside);
					close.removeEventListener("click", closePreview);
					overlay.remove();
					if (previousFocus?.isConnected) previousFocus.focus();
				};
				document.body.append(overlay);
				close.focus();
			};
			const openAttachment = async (item, name) => {
				if (disabled || disposed || !items.includes(item)) return;
				notice.textContent = "";
				const content = "existing" in item ? item.existing.content : void 0;
				const draft = "draft" in item ? item.draft : void 0;
				try {
					if (content?.type === "image" || draft?.kind === "image") {
						closePreview();
						const revision = previewRevision;
						previewItem = item;
						let src;
						if (draft?.kind === "image") src = draft.previewUrl;
						else if ("existing" in item) src = await imageUrl(item.existing);
						else return;
						if (!disabled && !disposed && items.includes(item) && revision === previewRevision) showPreview(src, name, item);
					} else if ("existing" in item) {
						if (options.openExisting === void 0) throw new Error("当前编辑入口尚不支持打开文件。");
						await options.openExisting(item.existing.blockIndex);
					} else {
						if (options.openDraft === void 0) throw new Error("当前编辑入口尚不支持打开文件。");
						await options.openDraft(item.draft);
					}
				} catch (error) {
					if (!disposed) notice.textContent = error instanceof Error ? error.message : String(error);
				}
			};
			const refresh = () => {
				if (disposed) return;
				const uploads = items.some((item) => "draft" in item && item.draft.kind === "file") ? tools.uploads() : {};
				const pending = items.some((item) => "draft" in item && item.draft.kind === "file" && uploads[item.draft.id]?.status !== "ready");
				const cards = items.map((item) => {
					const card = document.createElement("div");
					card.className = InlineMessageEdit_module_css_default["attachmentCard"] ?? "";
					const content = "existing" in item ? item.existing.content : void 0;
					const draft = "draft" in item ? item.draft : void 0;
					const name = content?.attachment.name ?? draft?.file.name ?? "图片附件";
					const bytes = content?.attachment.bytes ?? draft?.file.size ?? 0;
					const isImage = content?.type === "image" || draft?.kind === "image";
					const open = document.createElement("button");
					open.type = "button";
					open.className = InlineMessageEdit_module_css_default["attachmentOpen"] ?? "";
					open.setAttribute("data-kind", isImage ? "image" : "file");
					open.setAttribute("aria-label", isImage ? `放大图片：${name}` : `打开文件：${name}`);
					open.title = isImage ? "点击放大图片" : "使用默认应用打开文件";
					open.disabled = disabled;
					open.addEventListener("click", () => {
						openAttachment(item, name);
					});
					const preview = document.createElement(isImage ? "img" : "span");
					preview.className = InlineMessageEdit_module_css_default["attachmentPreview"] ?? "";
					if (isImage) {
						const image = preview;
						image.alt = name;
						if (draft?.kind === "image") image.src = draft.previewUrl;
						if (content?.type === "image" && "existing" in item) imageUrl(item.existing).then((value) => {
							if (!disposed) image.src = value;
						}).catch(() => {
							if (!disposed) image.alt = `${name}（预览暂不可用）`;
						});
					} else preview.textContent = "文件";
					const info = document.createElement("div");
					info.className = InlineMessageEdit_module_css_default["attachmentInfo"] ?? "";
					const label = document.createElement("span");
					label.textContent = name;
					label.title = name;
					const status = document.createElement("span");
					status.className = InlineMessageEdit_module_css_default["attachmentStatus"] ?? "";
					const upload = draft?.kind === "file" ? uploads[draft.id] : void 0;
					status.textContent = upload?.status === "error" ? `上传失败：${upload.message}` : draft?.kind === "file" && upload?.status !== "ready" ? upload?.status === "uploading" && upload.total ? `上传中 ${String(Math.round(upload.loaded / upload.total * 100))}%` : "正在上传…" : sizeLabel(bytes);
					info.append(label, status);
					const remove = document.createElement("button");
					remove.type = "button";
					remove.className = InlineMessageEdit_module_css_default["attachmentRemove"] ?? "";
					remove.textContent = "×";
					remove.title = `移除 ${name}`;
					remove.setAttribute("aria-label", `移除附件：${name}`);
					remove.disabled = disabled;
					remove.addEventListener("click", () => {
						if (disabled || disposed) return;
						const index = items.indexOf(item);
						if (index < 0) return;
						items.splice(index, 1);
						if (previewItem === item) closePreview();
						if ("draft" in item) tools.release(item.draft.id);
						refresh();
					});
					open.append(preview, info);
					card.append(open, remove);
					if (upload?.status === "error" && draft !== void 0) {
						const retry = document.createElement("button");
						retry.type = "button";
						retry.textContent = "重试上传";
						retry.disabled = disabled;
						retry.addEventListener("click", () => {
							if (!disabled && !disposed) tools.retry(draft.id);
						});
						card.append(retry);
					}
					return card;
				});
				list.replaceChildren(...cards);
				add.disabled = disabled;
				picker.disabled = disabled;
				onBusy(pending);
			};
			const addFiles = (files) => {
				if (disabled || disposed || files.length === 0) return;
				try {
					for (const draft of tools.create(files)) items.push({ draft });
					unsubscribe ??= tools.subscribe(refresh);
					notice.textContent = "";
					refresh();
				} catch (error) {
					notice.textContent = error instanceof Error ? error.message : String(error);
				}
			};
			const openPicker = () => {
				if (!disabled && !disposed) picker.click();
			};
			const picked = () => {
				try {
					if (!disabled && !disposed) {
						const files = Array.from(picker.files ?? []);
						if (files.length > 0) (options.onFiles ?? addFiles)(files);
					}
				} catch (error) {
					notice.textContent = error instanceof Error ? error.message : String(error);
				} finally {
					picker.value = "";
				}
			};
			add.addEventListener("click", openPicker);
			picker.addEventListener("change", picked);
			refresh();
			return {
				addFiles,
				pickFiles: openPicker,
				serialize: async () => {
					const drafts = items.flatMap((item) => "draft" in item ? [item.draft.id] : []);
					const uploaded = drafts.length === 0 ? [] : await tools.serialize(drafts);
					let index = 0;
					return items.map((item) => {
						if ("existing" in item) return {
							type: "retained",
							blockIndex: item.existing.blockIndex
						};
						const attachment = uploaded[index++];
						if (attachment === void 0) throw new Error("附件尚未准备完成，请稍后重试。");
						return attachment;
					});
				},
				setDisabled: (value) => {
					disabled = value;
					if (value) closePreview();
					refresh();
				},
				dispose: () => {
					if (disposed) return;
					disposed = true;
					closePreview();
					unsubscribe?.();
					add.removeEventListener("click", openPicker);
					picker.removeEventListener("change", picked);
					for (const item of items) if ("draft" in item) tools.release(item.draft.id);
					add.remove();
					picker.remove();
					container.replaceChildren();
				}
			};
		}
		//#endregion
		//#region src/client/fileReferences.ts
		const invalidPathCharacters = /[\u0000-\u001f\u007f-\u009f"]/u;
		/** 使用桌面端提供的真实路径；浏览器内创建的文件没有宿主路径。 */
		function filePathFor(file) {
			const bridge = globalThis.__DSH_HOST_PATHS__;
			try {
				const path = bridge?.pathFor(file);
				return path === void 0 || path === "" ? void 0 : path;
			} catch {
				return;
			}
		}
		/** 对齐官方 @ 文件语法，空格使用双引号，路径分隔符统一为斜杠。 */
		function formatFileReference(path) {
			if (path === "" || invalidPathCharacters.test(path)) throw new Error("文件路径无法表示为 DSH 引用。");
			const normalized = path.replace(/\\/gu, "/");
			return /\s/u.test(normalized) ? `@"${normalized}"` : `@${normalized}`;
		}
		function pathFromClipboardLine(line) {
			let path = line.trim();
			if (path.startsWith("\"") && path.endsWith("\"")) path = path.slice(1, -1);
			if (/^file:/iu.test(path)) try {
				const address = new URL(path);
				if (address.protocol !== "file:" || address.search !== "" || address.hash !== "") return void 0;
				path = decodeURIComponent(address.pathname);
				if (address.hostname !== "" && address.hostname !== "localhost") path = `//${address.hostname}${path}`;
				else if (/^\/[a-z]:\//iu.test(path)) path = path.slice(1);
			} catch {
				return;
			}
			if (invalidPathCharacters.test(path)) return void 0;
			if (/^\/[^/]*$/u.test(path) && !/^\/[^\s]+\.[a-z0-9]+$/iu.test(path)) return void 0;
			if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/]|\/)/iu.test(path)) return void 0;
			return path.replace(/\\/gu, "/");
		}
		/** 只读取剪贴板的路径文本；实际 File 由 filePathFor 处理，图片不会重复添加。 */
		function pastedFilePaths(data) {
			const result = [];
			const seen = /* @__PURE__ */ new Set();
			const read = (type) => {
				try {
					return data.getData(type);
				} catch {
					return "";
				}
			};
			for (const type of ["text/uri-list", "text/plain"]) {
				const paths = read(type).split(/\r\n|\n|\r/u).filter((line) => line.trim() !== "" && (type !== "text/uri-list" || !line.trimStart().startsWith("#"))).map(pathFromClipboardLine);
				if (paths.some((path) => path === void 0)) continue;
				for (const path of paths) {
					if (path === void 0 || seen.has(path)) continue;
					seen.add(path);
					result.push(path);
				}
			}
			return result;
		}
		/** 提取完整文件引用与文本位置；邮件地址和 @ 会话引用保留为普通文字。 */
		function parseFileReferences(text) {
			const result = [];
			for (const match of text.matchAll(/(?:^|\s)(@(?:"([^"\r\n]+)"|([^\s"]+)))/gu)) {
				const token = match[1];
				const path = match[2] ?? match[3];
				if (token === void 0 || path === void 0 || invalidPathCharacters.test(path)) continue;
				if (path.startsWith("[") || path.startsWith("dsh-session:")) continue;
				const start = match.index + match[0].length - token.length;
				const normalized = path.replace(/\\/gu, "/");
				const folder = normalized.endsWith("/");
				const name = normalized.replace(/\/+$/u, "").split("/").at(-1) || normalized;
				result.push({
					start,
					end: start + token.length,
					path,
					token,
					label: `${name}${folder ? "/" : ""}`
				});
			}
			return result;
		}
		function sessionReferenceUri(sessionId) {
			const bytes = new TextEncoder().encode(JSON.stringify(sessionId));
			const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
			return `dsh-session:${btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")}`;
		}
		/** 识别 canonical 会话引用；错误 URI 继续保留文字，不生成可导航 chip。 */
		function parseSessionReferences(text) {
			const result = [];
			for (const match of text.matchAll(/@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu)) {
				const uri = match[2] ?? match[3];
				if (uri === void 0) continue;
				const payload = uri.slice(12);
				if (!/^[A-Za-z0-9_-]+$/u.test(payload)) continue;
				try {
					const binary = atob(payload.replace(/-/gu, "+").replace(/_/gu, "/"));
					const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
					const sessionId = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
					if (typeof sessionId !== "string" || sessionReferenceUri(sessionId) !== uri) continue;
					const token = match[0];
					const label = match[1] === void 0 ? sessionId : match[1].replace(/\\(.)/gu, "$1");
					result.push({
						start: match.index,
						end: match.index + token.length,
						sessionId,
						token,
						label
					});
				} catch {
					continue;
				}
			}
			return result;
		}
		//#endregion
		//#region src/client/RichMessageInput.ts
		function escapeHtml(text) {
			return text.replace(/[&<>"']/g, (value) => ({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				"\"": "&quot;",
				"'": "&#39;"
			})[value]);
		}
		/** 引用以原生 @路径持久化，显示节点只负责高亮和点击。 */
		function referenceHtml(text) {
			let result = "";
			let offset = 0;
			const sessions = parseSessionReferences(text);
			const files = parseFileReferences(text).filter((file) => !sessions.some((session) => file.start >= session.start && file.start < session.end));
			for (const reference of [...files, ...sessions].sort((left, right) => left.start - right.start)) {
				result += escapeHtml(text.slice(offset, reference.start)).replace(/\n/g, "<br>");
				const location = "path" in reference ? `data-file-path="${escapeHtml(reference.path)}"` : `data-session-id="${escapeHtml(reference.sessionId)}"`;
				result += `<span class="${InlineMessageEdit_module_css_default["fileReference"] ?? ""}" contenteditable="false" role="link" tabindex="0" ${location} data-file-token="${escapeHtml(reference.token)}" title="${escapeHtml("path" in reference ? reference.path : reference.label)}">${"path" in reference ? "▤" : "@"} ${escapeHtml(reference.label)}</span>`;
				offset = reference.end;
			}
			return result + escapeHtml(text.slice(offset)).replace(/\n/g, "<br>");
		}
		/** 同时处理浏览器生成的段落和粘贴插入的换行，保留多行正文。 */
		function messageInputText(node) {
			if (node.nodeType === 3) return node.textContent ?? "";
			const element = node;
			if (element.dataset?.["fileToken"] !== void 0) return element.dataset["fileToken"];
			if (element.tagName === "BR") return "\n";
			const children = Array.from(node.childNodes ?? []);
			let result = "";
			for (const child of children) {
				const block = child.nodeType === 1 && /^(DIV|P)$/.test(child.tagName);
				if (block && result !== "" && !result.endsWith("\n")) result += "\n";
				result += messageInputText(child);
				if (block && child !== children.at(-1) && !result.endsWith("\n")) result += "\n";
			}
			return children.length === 0 ? node.textContent ?? "" : result.replace(/\u00a0/g, " ");
		}
		/** 独立内容框使用浏览器编辑历史，不绑定主会话的单例草稿。 */
		function mountRichMessageInput(container, initialText, options) {
			const input = document.createElement("div");
			input.className = `${InlineMessageEdit_module_css_default["input"] ?? ""} ${InlineMessageEdit_module_css_default["richInput"] ?? ""}`;
			input.contentEditable = "true";
			input.setAttribute("role", "textbox");
			input.setAttribute("aria-label", "消息正文");
			input.setAttribute("aria-multiline", "true");
			input.setAttribute("data-placeholder", "编辑消息，粘贴文件，输入 / 调用指令、@ 引用文件或对话");
			input.innerHTML = referenceHtml(initialText);
			container.append(input);
			let disabled = false;
			let disposed = false;
			let composing = false;
			let edited = false;
			let caret;
			const selection = () => document.getSelection();
			const remember = () => {
				const current = selection();
				if (current?.rangeCount && input.contains(current.anchorNode)) caret = current.getRangeAt(0).cloneRange();
			};
			const focus = () => {
				input.focus();
				const current = selection();
				if (current === null) return;
				const range = caret ?? document.createRange();
				if (caret === void 0) {
					range.selectNodeContents(input);
					range.collapse(false);
				}
				current.removeAllRanges();
				current.addRange(range);
			};
			const changed = () => {
				if (composing) return;
				edited = true;
				remember();
				const current = selection();
				const prefix = document.createRange();
				prefix.selectNodeContents(input);
				if (current?.rangeCount && input.contains(current.anchorNode)) {
					const range = current.getRangeAt(0);
					prefix.setEnd(range.endContainer, range.endOffset);
				}
				options.onChange?.(messageInputText(prefix.cloneContents()));
			};
			const insert = (text) => {
				if (disabled || disposed) return;
				focus();
				const current = selection();
				if (current?.rangeCount && (parseFileReferences(text)[0]?.start === 0 || parseSessionReferences(text)[0]?.start === 0)) {
					const range = current.getRangeAt(0);
					const prefix = document.createRange();
					prefix.selectNodeContents(input);
					prefix.setEnd(range.startContainer, range.startOffset);
					const before = messageInputText(prefix.cloneContents());
					if (before !== "" && !/\s$/.test(before)) text = ` ${text}`;
				}
				document.execCommand("insertHTML", false, referenceHtml(text));
				changed();
			};
			const paste = (event) => {
				if (disabled || event.clipboardData === null) return;
				const files = Array.from(event.clipboardData.files);
				if (!files.length) for (const item of Array.from(event.clipboardData.items)) {
					const file = item.kind === "file" ? item.getAsFile() : null;
					if (file !== null) files.push(file);
				}
				const paths = files.length === 0 ? pastedFilePaths(event.clipboardData) : [];
				event.preventDefault();
				if (files.length) options.addFiles(files);
				else if (paths.length) options.addPaths(paths);
				else insert(event.clipboardData.getData("text/plain"));
			};
			const drop = (event) => {
				if (disabled || event.dataTransfer === null) return;
				event.preventDefault();
				const files = Array.from(event.dataTransfer.files);
				if (files.length) options.addFiles(files);
				else {
					const paths = pastedFilePaths(event.dataTransfer);
					if (paths.length) options.addPaths(paths);
					else insert(event.dataTransfer.getData("text/plain"));
				}
			};
			const dragOver = (event) => {
				if (!disabled) event.preventDefault();
			};
			const openReference = (event) => {
				const chip = event.target.closest("[data-file-path], [data-session-id]");
				if (chip === null || !input.contains(chip)) return;
				if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				const path = chip.dataset["filePath"];
				if (path !== void 0) options.openPath(path).catch(options.onError);
				const sessionId = chip.dataset["sessionId"];
				if (sessionId !== void 0) options.openSession(sessionId);
			};
			const keydown = (event) => {
				if (composing || event.isComposing || event.keyCode === 229 || disabled) return;
				if (event.target.dataset["fileToken"] !== void 0) {
					openReference(event);
					return;
				}
				if (options.onKeydown?.(event)) return;
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
					event.preventDefault();
					options.onSave();
				} else if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
					event.preventDefault();
					options.onSend();
				}
			};
			const copy = (event) => {
				const current = selection();
				if (current?.rangeCount && input.contains(current.anchorNode) && event.clipboardData !== null) {
					event.clipboardData.setData("text/plain", messageInputText(current.getRangeAt(0).cloneContents()));
					event.preventDefault();
					if (event.type === "cut" && !disabled) document.execCommand("delete");
				}
			};
			const compositionStart = () => {
				composing = true;
			};
			const compositionEnd = () => {
				composing = false;
				changed();
			};
			input.addEventListener("compositionstart", compositionStart);
			input.addEventListener("compositionend", compositionEnd);
			input.addEventListener("input", changed);
			input.addEventListener("keyup", remember);
			input.addEventListener("mouseup", remember);
			input.addEventListener("blur", remember);
			input.addEventListener("paste", paste);
			input.addEventListener("drop", drop);
			input.addEventListener("dragover", dragOver);
			input.addEventListener("click", openReference);
			input.addEventListener("keydown", keydown);
			input.addEventListener("copy", copy);
			input.addEventListener("cut", copy);
			return {
				text: () => edited ? messageInputText(input) : initialText,
				insert,
				focus,
				replaceTrailing: (token, text) => {
					if (disabled || disposed) return;
					focus();
					const current = selection();
					if (current === null) return;
					for (let index = 0; index < token.length; index++) current.modify("extend", "backward", "character");
					remember();
					insert(text);
				},
				setDisabled: (value) => {
					disabled = value;
					input.contentEditable = String(!value);
					input.setAttribute("aria-disabled", String(value));
				},
				dispose: () => {
					disposed = true;
					input.removeEventListener("compositionstart", compositionStart);
					input.removeEventListener("compositionend", compositionEnd);
					input.removeEventListener("input", changed);
					input.removeEventListener("keyup", remember);
					input.removeEventListener("mouseup", remember);
					input.removeEventListener("blur", remember);
					input.removeEventListener("paste", paste);
					input.removeEventListener("drop", drop);
					input.removeEventListener("dragover", dragOver);
					input.removeEventListener("click", openReference);
					input.removeEventListener("keydown", keydown);
					input.removeEventListener("copy", copy);
					input.removeEventListener("cut", copy);
					input.remove();
				}
			};
		}
		//#endregion
		//#region src/client/MessageComposer.ts
		function button(label, className) {
			const element = document.createElement("button");
			element.type = "button";
			element.textContent = label;
			if (className !== void 0) element.className = className;
			return element;
		}
		/** 弹窗与 Timeline 共用独立的正文、附件及提交选项。 */
		function mountMessageComposer(container, block, attachmentTools, tools, events) {
			const frame = document.createElement("div");
			frame.className = InlineMessageEdit_module_css_default["composer"] ?? "";
			const attachments = document.createElement("div");
			const inputContainer = document.createElement("div");
			const toolbar = document.createElement("div");
			toolbar.className = InlineMessageEdit_module_css_default["composerToolbar"] ?? "";
			const plus = button("+", InlineMessageEdit_module_css_default["composerPlus"]);
			plus.setAttribute("aria-label", "添加文件");
			plus.title = "添加文件";
			const permission = button("权限 ▾", InlineMessageEdit_module_css_default["composerControl"]);
			permission.setAttribute("aria-label", "修改权限");
			const model = button("模型 ▾", InlineMessageEdit_module_css_default["composerModel"]);
			model.setAttribute("aria-label", "修改模型和推理等级");
			const status = document.createElement("div");
			status.className = InlineMessageEdit_module_css_default["attachmentNotice"] ?? "";
			status.setAttribute("role", "status");
			const popup = document.createElement("div");
			popup.className = InlineMessageEdit_module_css_default["composerMenu"] ?? "";
			popup.hidden = true;
			const suggestions = document.createElement("div");
			suggestions.className = InlineMessageEdit_module_css_default["referenceSuggestions"] ?? "";
			suggestions.hidden = true;
			toolbar.append(plus, permission, model);
			frame.append(attachments, inputContainer, suggestions, popup, toolbar);
			container.append(frame, status);
			let disabled = false;
			let disposed = false;
			let options;
			let draftSettings = {};
			let search;
			let searchTimer;
			let highlighted = 0;
			let richInput;
			let attachmentEditor;
			const showError = (error) => {
				if (!disposed) status.textContent = error instanceof Error ? error.message : String(error);
			};
			const addPaths = (paths) => {
				richInput.insert(paths.map((path) => formatFileReference(path)).join(" ") + " ");
			};
			const addFiles = (files) => {
				if (disabled || disposed) return;
				const uploads = [];
				const paths = [];
				for (const file of files) {
					const path = filePathFor(file);
					if (path !== void 0 && !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) paths.push(path);
					else uploads.push(file);
				}
				if (paths.length) addPaths(paths);
				if (uploads.length) attachmentEditor.addFiles(uploads);
			};
			const closeMenu = () => {
				popup.hidden = true;
				permission.setAttribute("aria-expanded", "false");
				model.setAttribute("aria-expanded", "false");
			};
			const beginMenu = (label, kind = "command") => {
				popup.replaceChildren();
				popup.setAttribute("role", "menu");
				popup.setAttribute("aria-label", label);
				popup.dataset["kind"] = kind;
				popup.hidden = false;
				permission.setAttribute("aria-expanded", String(kind === "permission"));
				model.setAttribute("aria-expanded", String(kind === "model" || kind === "modelList"));
			};
			const menuItem = (label, description, act, selected, target = popup) => {
				const item = button("");
				const text = document.createElement("span");
				text.className = InlineMessageEdit_module_css_default["menuItemLabel"] ?? "";
				text.textContent = label;
				item.setAttribute("role", selected === void 0 ? "menuitem" : "menuitemradio");
				if (selected !== void 0) item.setAttribute("aria-checked", String(selected));
				item.title = label;
				const hint = document.createElement("span");
				hint.className = InlineMessageEdit_module_css_default["menuValue"] ?? "";
				hint.textContent = selected === void 0 ? description : selected ? "✓" : "";
				if (selected !== void 0) hint.setAttribute("aria-hidden", "true");
				item.append(text, hint);
				item.disabled = disabled;
				item.addEventListener("click", () => {
					closeMenu();
					act();
				});
				target.append(item);
				return item;
			};
			const permissionLabel = (id) => {
				return id === void 0 ? "权限" : {
					"read-only": "仅可查看",
					"workspace-write": "工作区内修改",
					"danger-full-access": "完全权限",
					"auto-review": "Auto review"
				}[id] ?? options?.permissions.find((preset) => preset.id === id)?.label ?? (id === "custom" ? "自定义权限" : id);
			};
			const effortLabel = (effort) => {
				if (!effort) return "默认";
				const values = {
					...options?.current,
					...draftSettings
				};
				return (options?.models.find((entry) => entry.provider === values.provider && entry.model === values.model))?.reasoningEffortLabels?.[effort] ?? {
					off: "Off",
					low: "Low",
					medium: "Medium",
					high: "High",
					max: "Max"
				}[effort] ?? effort;
			};
			const updateControls = () => {
				const values = {
					...options?.current,
					...draftSettings
				};
				permission.textContent = `${permissionLabel(values.permissionPreset)} ▾`;
				const selected = options?.models.find((entry) => entry.provider === values.provider && entry.model === values.model);
				model.textContent = `${selected?.label ?? values.model ?? "模型"}${values.reasoningEffort ? ` ${effortLabel(values.reasoningEffort)}` : ""} ▾`;
				model.title = model.textContent;
			};
			const permissionMenu = () => {
				beginMenu("选择权限", "permission");
				const values = {
					...options?.current,
					...draftSettings
				};
				for (const preset of options?.permissions ?? []) {
					const item = menuItem(permissionLabel(preset.id), "", () => {
						draftSettings.permissionPreset = preset.id;
						updateControls();
						richInput.focus();
					}, preset.id === values.permissionPreset);
					item.title = preset.description ?? permissionLabel(preset.id);
				}
				if (options === void 0) menuItem("重新加载选项", "", () => {
					loadOptions();
				});
			};
			const modelMenu = () => {
				beginMenu("选择模型和推理等级", "model");
				const values = {
					...options?.current,
					...draftSettings
				};
				const selected = options?.models.find((entry) => entry.provider === values.provider && entry.model === values.model);
				menuItem("模型", `${selected?.label ?? values.model ?? "选择模型"} ›`, modelList);
				if (selected?.reasoningEfforts.length) menuItem("推理等级", `${effortLabel(values.reasoningEffort)} ›`, () => {
					beginMenu("选择推理等级", "model");
					menuItem("‹ 推理等级", "", modelMenu);
					for (const effort of ["", ...selected.reasoningEfforts]) menuItem(effortLabel(effort), "", () => {
						draftSettings = {
							...draftSettings,
							provider: selected.provider,
							model: selected.model,
							reasoningEffort: effort
						};
						updateControls();
						richInput.focus();
					}, effort === (values.reasoningEffort ?? ""));
				});
				if (options === void 0) menuItem("重新加载选项", "", () => {
					loadOptions();
				});
			};
			const modelList = () => {
				beginMenu("选择模型", "modelList");
				const back = menuItem("‹ 模型", "", modelMenu);
				back.className = InlineMessageEdit_module_css_default["menuBack"] ?? "";
				const field = document.createElement("input");
				field.placeholder = "搜索模型…";
				field.setAttribute("aria-label", "搜索模型");
				field.className = InlineMessageEdit_module_css_default["modelSearch"] ?? "";
				const list = document.createElement("div");
				list.className = InlineMessageEdit_module_css_default["modelList"] ?? "";
				popup.append(field, list);
				const render = () => {
					list.replaceChildren();
					const values = {
						...options?.current,
						...draftSettings
					};
					const query = field.value.trim().toLocaleLowerCase();
					const groups = /* @__PURE__ */ new Map();
					for (const entry of options?.models ?? []) {
						if (query && !`${entry.label} ${entry.model} ${entry.providerLabel ?? entry.provider}`.toLocaleLowerCase().includes(query)) continue;
						const group = groups.get(entry.provider) ?? [];
						group.push(entry);
						groups.set(entry.provider, group);
					}
					for (const entries of groups.values()) {
						const heading = document.createElement("div");
						heading.className = InlineMessageEdit_module_css_default["menuHeading"] ?? "";
						heading.textContent = entries[0]?.providerLabel ?? entries[0]?.provider ?? "";
						list.append(heading);
						for (const entry of entries) menuItem(entry.label, "", () => {
							draftSettings = {
								...draftSettings,
								provider: entry.provider,
								model: entry.model
							};
							if (!entry.reasoningEfforts.includes(values.reasoningEffort ?? "")) draftSettings.reasoningEffort = "";
							updateControls();
							richInput.focus();
						}, entry.provider === values.provider && entry.model === values.model, list);
					}
					if (!groups.size) {
						const empty = document.createElement("div");
						empty.className = InlineMessageEdit_module_css_default["menuHeading"] ?? "";
						empty.textContent = "没有找到匹配的模型";
						list.append(empty);
					}
				};
				field.addEventListener("input", render);
				render();
				field.focus();
			};
			const executeCommand = (line) => {
				if (disabled) return;
				status.textContent = "正在执行指令…";
				tools.command(line).then(() => {
					if (!disposed) status.textContent = "指令已执行。";
				}).catch(showError);
			};
			const commandForm = (name, label, placeholder) => {
				beginMenu(label);
				const field = document.createElement("input");
				field.placeholder = placeholder;
				field.setAttribute("aria-label", label);
				const run = button(label);
				run.addEventListener("click", () => {
					closeMenu();
					executeCommand(`/${name}${field.value.trim() ? ` ${field.value.trim()}` : ""}`);
				});
				popup.append(field, run);
				field.focus();
			};
			const planMenu = () => {
				beginMenu("计划模式");
				menuItem("进入计划模式", "先规划，再执行", () => executeCommand("/plan"));
				menuItem("退出计划模式", "恢复正常对话", () => executeCommand("/plan off"));
			};
			const chooseCommand = (name) => {
				switch (name) {
					case "file":
						attachmentEditor.pickFiles();
						break;
					case "goal":
						commandForm("goal", "设置或查看目标", "输入目标；留空查看当前目标");
						break;
					case "plan":
						planMenu();
						break;
					case "feedback":
						commandForm("feedback", "发送反馈", "输入反馈内容");
						break;
					case "permission":
						permissionMenu();
						break;
					case "model":
						modelMenu();
						break;
					default: executeCommand(`/${name}`);
				}
			};
			const suggestReferences = (text) => {
				search?.abort();
				if (searchTimer !== void 0) clearTimeout(searchTimer);
				suggestions.hidden = true;
				const slash = /^\/([^\s]*)$/.exec(text);
				const match = /(?:^|\s)@([^\s@]*)$/.exec(text);
				if (slash !== null) {
					const controller = new AbortController();
					search = controller;
					tools.commands(slash[1] ?? "", controller.signal).then((commands) => {
						if (disposed || controller.signal.aborted || !commands.length) return;
						suggestions.replaceChildren();
						suggestions.setAttribute("role", "listbox");
						suggestions.setAttribute("aria-label", "指令候选");
						for (const command of commands.slice(0, 12)) {
							const item = button(`${command.label ?? command.name} /${command.name}`);
							item.setAttribute("role", "option");
							item.addEventListener("mousedown", (event) => event.preventDefault());
							item.addEventListener("click", () => {
								suggestions.hidden = true;
								richInput.replaceTrailing(`/${slash[1] ?? ""}`, "");
								chooseCommand(command.name);
							});
							suggestions.append(item);
						}
						highlighted = 0;
						suggestions.hidden = false;
						suggestions.children[0]?.setAttribute("aria-selected", "true");
					}).catch((error) => {
						if (!controller.signal.aborted) showError(error);
					});
					return;
				}
				if (match === null) return;
				const query = match[1] ?? "";
				searchTimer = setTimeout(() => {
					const controller = new AbortController();
					search = controller;
					tools.references(query, controller.signal).then((results) => {
						if (disposed || controller.signal.aborted || !results.length) return;
						suggestions.replaceChildren();
						suggestions.setAttribute("role", "listbox");
						suggestions.setAttribute("aria-label", "文件引用候选");
						for (const reference of results.slice(0, 12)) {
							const item = button(`${reference.kind === "folder" ? "▱" : reference.kind === "session" ? "@" : "▤"} ${reference.label}`);
							item.title = reference.kind === "session" ? reference.label : reference.path;
							item.setAttribute("role", "option");
							item.addEventListener("mousedown", (event) => event.preventDefault());
							item.addEventListener("click", () => {
								richInput.replaceTrailing(`@${query}`, `${reference.kind === "session" ? reference.mention : formatFileReference(reference.path)} `);
								suggestions.hidden = true;
							});
							suggestions.append(item);
						}
						suggestions.hidden = false;
						highlighted = 0;
						suggestions.children[0]?.setAttribute("aria-selected", "true");
					}).catch((error) => {
						if (!controller.signal.aborted) showError(error);
					});
				}, 150);
			};
			richInput = mountRichMessageInput(inputContainer, block.text, {
				addFiles,
				addPaths,
				openPath: tools.openPath,
				openSession: tools.openSession,
				onError: showError,
				onSend: events.onSend,
				onSave: events.onSave,
				onChange: suggestReferences,
				onKeydown: (event) => {
					if (suggestions.hidden) return false;
					if (event.key === "Escape") {
						suggestions.hidden = true;
						event.preventDefault();
						return true;
					}
					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						const direction = event.key === "ArrowUp" ? -1 : 1;
						highlighted = (highlighted + direction + suggestions.children.length) % suggestions.children.length;
						for (const [index, item] of Array.from(suggestions.children).entries()) item.setAttribute("aria-selected", String(index === highlighted));
						event.preventDefault();
						return true;
					}
					if (event.key === "Enter" || event.key === "Tab") {
						suggestions.children[highlighted]?.click();
						event.preventDefault();
						return true;
					}
					return false;
				}
			});
			attachmentEditor = mountAttachmentEditor(attachments, block.attachments ?? [], attachmentTools, events.onBusy, void 0, {
				hideAdd: true,
				onFiles: addFiles,
				openExisting: (blockIndex) => tools.openAttachment(block.eventSeq, blockIndex),
				openDraft: async (draft) => {
					const path = filePathFor(draft.file);
					if (path !== void 0) return tools.openPath(path);
					const [payload] = await attachmentTools.serialize([draft.id]);
					if (payload?.type !== "file") throw new Error("附件尚未准备完成，请稍后重试。");
					await tools.openUpload(payload.receiptId);
				}
			});
			const loadOptions = async () => {
				try {
					const result = await tools.options();
					if (!Array.isArray(result.models) || !Array.isArray(result.permissions)) throw new Error("宿主尚未提供编辑选项，请安装新版插件并重启 DSH。");
					if (disposed) return;
					options = result;
					updateControls();
				} catch (error) {
					showError(error);
				}
			};
			const outside = (event) => {
				const path = event.composedPath();
				if (!path.includes(popup) && !path.includes(plus) && !path.includes(permission) && !path.includes(model)) closeMenu();
			};
			const togglePermission = () => {
				if (!popup.hidden && popup.getAttribute("aria-label") === "选择权限") closeMenu();
				else permissionMenu();
			};
			const toggleModel = () => {
				if (!popup.hidden && (popup.dataset["kind"] === "model" || popup.dataset["kind"] === "modelList")) closeMenu();
				else modelMenu();
			};
			frame.addEventListener("keydown", (event) => {
				if (event.isComposing || event.keyCode === 229) return;
				if (event.key === "Escape" && !popup.hidden) {
					closeMenu();
					richInput.focus();
					event.stopPropagation();
				}
			});
			plus.addEventListener("click", () => {
				closeMenu();
				attachmentEditor.pickFiles();
			});
			permission.addEventListener("click", togglePermission);
			model.addEventListener("click", toggleModel);
			document.addEventListener("click", outside);
			loadOptions();
			return {
				text: richInput.text,
				settings: (regenerate) => {
					const settings = {
						...regenerate ? options?.current : {},
						...draftSettings
					};
					if (settings.permissionPreset !== void 0 && !options?.permissions.some((item) => item.id === settings.permissionPreset)) delete settings.permissionPreset;
					if (settings.reasoningEffort === "") delete settings.reasoningEffort;
					return Object.keys(settings).length ? settings : void 0;
				},
				serialize: () => attachmentEditor.serialize(),
				focus: richInput.focus,
				setDisabled: (value) => {
					disabled = value;
					richInput.setDisabled(value);
					attachmentEditor.setDisabled(value);
					plus.disabled = value;
					permission.disabled = value;
					model.disabled = value;
					if (value) {
						closeMenu();
						suggestions.hidden = true;
					}
				},
				dispose: () => {
					disposed = true;
					search?.abort();
					if (searchTimer !== void 0) clearTimeout(searchTimer);
					document.removeEventListener("click", outside);
					attachmentEditor.dispose();
					richInput.dispose();
					frame.remove();
					status.remove();
				}
			};
		}
		//#endregion
		//#region src/client/InlineMessageEdit.tsx
		/**
		* Message-row edit affordance: injects retry + edit icon buttons into each
		* settled message's icon-actions row (the official MessageIconActions has no
		* plugin slot, so injection rides a MutationObserver over action rows).
		* Icons are the official outline-16 SVGs inlined to avoid bundling the
		* primitives package.
		*/
		const BLOCK_TITLE = {
			user: "编辑用户消息",
			"assistant.reasoning": "编辑助手思考",
			"assistant.response": "编辑助手回复"
		};
		const STYLE = {
			overlay: InlineMessageEdit_module_css_default["overlay"] ?? "",
			panel: InlineMessageEdit_module_css_default["panel"] ?? "",
			title: InlineMessageEdit_module_css_default["title"] ?? "",
			input: InlineMessageEdit_module_css_default["input"] ?? "",
			footer: InlineMessageEdit_module_css_default["footer"] ?? "",
			iconButton: InlineMessageEdit_module_css_default["iconButton"] ?? "",
			picker: InlineMessageEdit_module_css_default["picker"] ?? "",
			pickerItem: InlineMessageEdit_module_css_default["pickerItem"] ?? "",
			pickerItemActive: InlineMessageEdit_module_css_default["pickerItemActive"] ?? ""
		};
		/** Official ic_ds_refresh_outline_16 path (dsh-client-ui-primitives). */
		const REFRESH_PATH = "M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z";
		/** Official ic_ds_edit_outline_16 path (dsh-client-ui-primitives). */
		const EDIT_PATH = "M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z";
		function svgIcon(path) {
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "16");
			svg.setAttribute("height", "16");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("fill", "none");
			const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
			p.setAttribute("d", path);
			p.setAttribute("fill", "currentColor");
			svg.appendChild(p);
			return svg;
		}
		function blockTitle(kind) {
			return BLOCK_TITLE[kind] ?? "编辑消息";
		}
		/** 编辑器支持用户消息只保存或保存并发送，关闭前确认取消。 */
		function mountEditor(block, edit, close, attachmentTools, composerTools) {
			const overlay = document.createElement("div");
			overlay.className = STYLE.overlay;
			const panel = document.createElement("div");
			panel.className = STYLE.panel;
			panel.setAttribute("role", "dialog");
			panel.setAttribute("aria-modal", "true");
			panel.setAttribute("aria-label", blockTitle(block.kind));
			const title = document.createElement("div");
			title.className = STYLE.title;
			title.textContent = blockTitle(block.kind);
			const input = document.createElement("textarea");
			input.className = STYLE.input;
			input.value = block.text;
			input.setAttribute("aria-label", "消息正文");
			const attachments = document.createElement("div");
			attachments.className = InlineMessageEdit_module_css_default["attachmentEditor"] ?? "";
			const error = document.createElement("div");
			error.className = InlineMessageEdit_module_css_default["attachmentNotice"] ?? "";
			error.setAttribute("role", "alert");
			const footer = document.createElement("div");
			footer.className = STYLE.footer;
			const save = document.createElement("button");
			save.type = "button";
			save.textContent = "保存";
			const send = block.kind === "user" ? document.createElement("button") : void 0;
			if (send !== void 0) {
				send.type = "button";
				send.textContent = "保存并发送";
			}
			const cancel = document.createElement("button");
			cancel.type = "button";
			cancel.textContent = "取消";
			footer.append(save, ...send === void 0 ? [] : [send], cancel);
			panel.append(title, ...block.kind === "user" ? [attachments] : [input], error, footer);
			overlay.appendChild(panel);
			document.body.appendChild(overlay);
			let mounted = true;
			let saving = false;
			let uploading = false;
			let composer;
			let closeConfirmation;
			const updateButtons = () => {
				save.disabled = saving || uploading;
				if (send !== void 0) send.disabled = saving || uploading;
				cancel.disabled = saving;
				input.readOnly = saving;
			};
			const applyEdit = (regenerate) => {
				if (saving || uploading) return;
				saving = true;
				updateButtons();
				composer?.setDisabled(true);
				error.textContent = "";
				(async () => {
					try {
						const payload = await composer?.serialize();
						if (!mounted) return;
						const applied = await edit(block, composer?.text() ?? input.value, "truncate", regenerate, payload, composer?.settings(regenerate));
						if (!mounted) return;
						if (applied) close();
						else error.textContent = "保存失败，请检查消息状态后重试。";
					} catch (cause) {
						if (mounted) error.textContent = cause instanceof Error ? cause.message : String(cause);
					} finally {
						if (mounted) {
							saving = false;
							composer?.setDisabled(false);
							updateButtons();
						}
					}
				})();
			};
			const saveEdit = () => {
				applyEdit(block.kind !== "user");
			};
			const saveAndSend = () => {
				applyEdit(true);
			};
			const cancelEdit = () => {
				if (saving || closeConfirmation !== void 0) return;
				closeConfirmation = confirmCancelEdit(() => {
					closeConfirmation = void 0;
					close();
				}, () => {
					closeConfirmation = void 0;
					if (composer === void 0) input.focus();
					else composer.focus();
				});
			};
			const dismiss = (event) => {
				if (event.target === overlay) cancelEdit();
			};
			if (block.kind === "user") {
				composer = mountMessageComposer(attachments, block, attachmentTools, composerTools, {
					onBusy: (busy) => {
						uploading = busy;
						updateButtons();
					},
					onSave: saveEdit,
					onSend: saveAndSend
				});
				composer.focus();
			} else {
				input.focus();
				input.setSelectionRange(input.value.length, input.value.length);
			}
			save.addEventListener("click", saveEdit);
			send?.addEventListener("click", saveAndSend);
			cancel.addEventListener("click", cancelEdit);
			overlay.addEventListener("click", dismiss);
			return () => {
				mounted = false;
				composer?.dispose();
				closeConfirmation?.();
				save.removeEventListener("click", saveEdit);
				send?.removeEventListener("click", saveAndSend);
				cancel.removeEventListener("click", cancelEdit);
				overlay.removeEventListener("click", dismiss);
				overlay.remove();
			};
		}
		/** Mount one block-picker DOM effect and return its exact inverse. */
		function mountPicker(blocks, select, close) {
			const overlay = document.createElement("div");
			overlay.className = STYLE.overlay;
			const panel = document.createElement("div");
			panel.className = STYLE.panel;
			const title = document.createElement("div");
			title.className = STYLE.title;
			title.textContent = blocks.some((block) => block.kind === "user") ? "编辑消息" : "编辑助手消息";
			const picker = document.createElement("div");
			picker.className = STYLE.picker;
			const itemListeners = [];
			for (const block of blocks) {
				const item = document.createElement("button");
				item.className = STYLE.pickerItem;
				item.textContent = `${blockTitle(block.kind)}：${block.text.slice(0, 24)}${block.text.length > 24 ? "…" : ""}`;
				const listener = () => {
					select(block);
				};
				item.addEventListener("click", listener);
				itemListeners.push({
					item,
					listener
				});
				picker.appendChild(item);
			}
			const cancel = document.createElement("button");
			cancel.textContent = "取消";
			cancel.className = STYLE.pickerItemActive;
			const cancelPicker = () => {
				close();
			};
			cancel.addEventListener("click", cancelPicker);
			panel.append(title, picker, cancel);
			overlay.appendChild(panel);
			document.body.appendChild(overlay);
			return () => {
				for (const { item, listener } of itemListeners) item.removeEventListener("click", listener);
				cancel.removeEventListener("click", cancelPicker);
				overlay.remove();
			};
		}
		/** Compose every overlay with a single idempotent active inverse. */
		function createOverlayHost(edit, attachmentTools, composerTools) {
			let active;
			const mount = (effect) => {
				active?.();
				let cleanup = () => {};
				let mounted = true;
				const close = () => {
					if (!mounted) return;
					mounted = false;
					cleanup();
					if (active === close) active = void 0;
				};
				active = close;
				try {
					cleanup = effect(close);
				} catch (error) {
					active = void 0;
					mounted = false;
					throw error;
				}
			};
			const editBlock = (block) => {
				mount((close) => mountEditor(block, edit, close, attachmentTools, composerTools));
			};
			const chooseBlock = (blocks) => {
				mount((close) => mountPicker(blocks, (block) => {
					close();
					editBlock(block);
				}, close));
			};
			return {
				editBlock,
				chooseBlock,
				dispose: () => {
					active?.();
				}
			};
		}
		/** 按消息标识更新操作按钮，数据刷新时保留按钮与正在编辑的弹窗。 */
		function InlineMessageEdit({ messages, edit, retry, attachmentTools, composerTools, disabled = false }) {
			const current = (0, react.useRef)({
				messages,
				disabled
			});
			current.current = {
				messages,
				disabled
			};
			const synchronize = (0, react.useRef)(void 0);
			(0, react.useLayoutEffect)(() => {
				const bindings = /* @__PURE__ */ new Map();
				const overlays = createOverlayHost(edit, attachmentTools, composerTools);
				let observer;
				let alive = true;
				let frame;
				let scheduled = false;
				const sync = () => {
					const actionRows = Array.from(document.querySelectorAll("[class*=\"actions\"]"));
					const presentRows = new Set(actionRows);
					for (const [row, binding] of bindings) {
						if (presentRows.has(row)) continue;
						binding.dispose();
						bindings.delete(row);
					}
					const blocksByEvent = /* @__PURE__ */ new Map();
					const turns = /* @__PURE__ */ new Map();
					for (const message of current.current.messages) {
						let blocks = blocksByEvent.get(message.eventSeq);
						if (blocks === void 0) {
							blocks = [];
							blocksByEvent.set(message.eventSeq, blocks);
						}
						blocks.push(message);
						let turn = turns.get(message.turn);
						if (turn === void 0) {
							turn = {};
							turns.set(message.turn, turn);
						}
						if (message.kind === "user") turn.user ??= message.eventSeq;
						else turn.assistant = message.eventSeq;
					}
					const claimedEvents = /* @__PURE__ */ new Set();
					for (const row of actionRows) {
						const marker = row;
						let binding = bindings.get(row);
						if (marker.__messageEditInjected === true && binding === void 0) {
							if (marker.__messageEditEventSeq !== void 0) claimedEvents.add(marker.__messageEditEventSeq);
							continue;
						}
						const node = row.closest("[data-chat-flow-kind]");
						const kind = node?.dataset["chatFlowKind"];
						const turn = Number(node?.dataset["chatTurn"]);
						const eventSeq = !Number.isSafeInteger(turn) || turn < 1 ? void 0 : kind === "user" ? turns.get(turn)?.user : kind === "turn-tail" ? turns.get(turn)?.assistant : void 0;
						const blocks = eventSeq === void 0 ? void 0 : blocksByEvent.get(eventSeq);
						if (eventSeq === void 0 || blocks === void 0 || claimedEvents.has(eventSeq)) {
							binding?.dispose();
							bindings.delete(row);
							continue;
						}
						claimedEvents.add(eventSeq);
						if (binding?.eventSeq === eventSeq && row.contains(binding.editButton) && row.contains(binding.retryButton)) {
							binding.blocks = blocks;
							binding.editButton.disabled = current.current.disabled;
							binding.retryButton.disabled = current.current.disabled;
							continue;
						}
						binding?.dispose();
						bindings.delete(row);
						const previousMarker = marker.__messageEditInjected;
						const previousEventSeq = marker.__messageEditEventSeq;
						marker.__messageEditInjected = true;
						marker.__messageEditEventSeq = eventSeq;
						const editButton = document.createElement("button");
						editButton.className = STYLE.iconButton;
						editButton.setAttribute("aria-label", "编辑消息");
						editButton.title = "编辑消息";
						editButton.setAttribute("data-message-edit-control", "");
						editButton.disabled = current.current.disabled;
						editButton.appendChild(svgIcon(EDIT_PATH));
						const editMessage = () => {
							if (current.current.disabled || binding === void 0) return;
							if (binding.blocks.length === 1 && binding.blocks[0] !== void 0) overlays.editBlock(binding.blocks[0]);
							else overlays.chooseBlock(binding.blocks);
						};
						editButton.addEventListener("click", editMessage);
						const retryButton = document.createElement("button");
						retryButton.className = STYLE.iconButton;
						retryButton.setAttribute("aria-label", "重试此回合");
						retryButton.title = "重试此回合";
						retryButton.setAttribute("data-message-edit-control", "");
						retryButton.disabled = current.current.disabled;
						retryButton.appendChild(svgIcon(REFRESH_PATH));
						const retryTurn = () => {
							if (current.current.disabled) return;
							const targetTurn = binding?.blocks[0]?.turn;
							if (targetTurn !== void 0) retry(targetTurn, "truncate");
						};
						retryButton.addEventListener("click", retryTurn);
						const lastOfficial = Array.from(row.querySelectorAll("button")).filter((button) => button !== editButton && button !== retryButton).at(-1);
						if (lastOfficial !== void 0) {
							lastOfficial.insertAdjacentElement("afterend", retryButton);
							lastOfficial.insertAdjacentElement("afterend", editButton);
						} else {
							row.appendChild(editButton);
							row.appendChild(retryButton);
						}
						const dispose = () => {
							editButton.removeEventListener("click", editMessage);
							retryButton.removeEventListener("click", retryTurn);
							editButton.remove();
							retryButton.remove();
							if (previousMarker === void 0) delete marker.__messageEditInjected;
							else marker.__messageEditInjected = previousMarker;
							if (previousEventSeq === void 0) delete marker.__messageEditEventSeq;
							else marker.__messageEditEventSeq = previousEventSeq;
						};
						binding = {
							eventSeq,
							blocks,
							editButton,
							retryButton,
							dispose
						};
						bindings.set(row, binding);
					}
				};
				synchronize.current = sync;
				sync();
				observer = new MutationObserver(() => {
					if (!alive || scheduled) return;
					scheduled = true;
					frame = requestAnimationFrame(() => {
						frame = void 0;
						scheduled = false;
						if (alive) sync();
					});
				});
				observer.observe(document.body, {
					childList: true,
					subtree: true
				});
				return () => {
					alive = false;
					if (frame !== void 0) cancelAnimationFrame(frame);
					observer?.disconnect();
					overlays.dispose();
					for (const binding of bindings.values()) binding.dispose();
					bindings.clear();
					if (synchronize.current === sync) synchronize.current = void 0;
				};
			}, [
				edit,
				retry,
				attachmentTools,
				composerTools
			]);
			(0, react.useLayoutEffect)(() => {
				synchronize.current?.();
			}, [messages, disabled]);
			return null;
		}
		//#endregion
		//#region \0dsh-css:D:\ai\home\codex\dsh-message-edit\src\client\MessageEditHeader.module.css.mjs
		const css$1 = ".g0PbfG_root{align-items:center;gap:4px;display:inline-flex}.g0PbfG_iconButton,.g0PbfG_rerollButton{box-sizing:border-box;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:0 0;border:0}.g0PbfG_iconButton{border-radius:50%;justify-content:center;align-items:center;width:28px;height:28px;font-size:16px;line-height:20px;display:inline-flex}.g0PbfG_rerollButton{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;height:28px;padding:0 10px;font-size:12px;line-height:18px}.g0PbfG_iconButton:hover:not(:disabled),.g0PbfG_rerollButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.g0PbfG_iconButton:focus-visible,.g0PbfG_rerollButton:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}.g0PbfG_iconButton:disabled,.g0PbfG_rerollButton:disabled{cursor:default;opacity:.4}.g0PbfG_counter{min-width:108px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:11px;line-height:18px}@media (width<=760px){.g0PbfG_counter{display:none}}";
		const tagId$1 = "@sh1robana/dsh-plugin-message-edit/MessageEditHeader.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@sh1robana/dsh-plugin-message-edit";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var MessageEditHeader_module_css_default = {
			"root": "g0PbfG_root",
			"counter": "g0PbfG_counter",
			"iconButton": "g0PbfG_iconButton",
			"rerollButton": "g0PbfG_rerollButton"
		};
		//#endregion
		//#region src/client/MessageEditHeader.tsx
		/** Header contribution shared with the Timeline controller. */
		function MessageEditHeader({ useMessageEdit, acquire, load, openVersion, reroll, edit, retry, attachmentTools, composerTools }) {
			const state = useMessageEdit((value) => value);
			(0, react.useEffect)(() => {
				const release = acquire();
				load();
				return release;
			}, [acquire, load]);
			const timeline = state.timeline;
			const versions = state.timeline?.versions ?? [];
			const undoSessionId = timeline?.undoStack[0];
			const redoSessionId = timeline?.redoSessionIds.at(-1);
			const effectDepth = timeline?.undoStack.length ?? 0;
			const busy = state.pending !== null || state.status !== "ready";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InlineMessageEdit, {
				messages: timeline?.messages ?? [],
				edit,
				retry,
				attachmentTools,
				composerTools,
				disabled: busy
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: MessageEditHeader_module_css_default["root"],
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: MessageEditHeader_module_css_default["iconButton"],
						"aria-label": "撤销当前版本效果",
						title: "撤销当前效果，保留更早效果",
						disabled: undoSessionId === void 0 || busy,
						onClick: () => {
							if (undoSessionId !== void 0) openVersion(undoSessionId);
						},
						children: "←"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: MessageEditHeader_module_css_default["counter"],
						children: versions.length === 0 ? "效果 —" : `效果 ${String(effectDepth)} 层 · ${String(versions.length)} 版`
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: MessageEditHeader_module_css_default["iconButton"],
						"aria-label": "重施加下一版本效果",
						title: timeline !== null && timeline.redoSessionIds.length > 1 ? `重施加最新效果（另有 ${String(timeline.redoSessionIds.length - 1)} 个分支）` : "重施加下一效果",
						disabled: redoSessionId === void 0 || busy,
						onClick: () => {
							if (redoSessionId !== void 0) openVersion(redoSessionId);
						},
						children: "→"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: MessageEditHeader_module_css_default["rerollButton"],
						disabled: busy || state.timeline === null,
						onClick: () => {
							reroll();
						},
						children: state.pending === "reroll" ? "正在重生成…" : "重生成"
					})
				]
			})] });
		}
		//#endregion
		//#region \0dsh-css:D:\ai\home\codex\dsh-message-edit\src\client\MessageEditTimelineView.module.css.mjs
		const css = ".Si12YW_root{box-sizing:border-box;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);padding:24px;overflow:auto}.Si12YW_pageHeader{justify-content:space-between;align-items:flex-start;gap:20px;max-width:1480px;margin:0 auto 16px;display:flex}.Si12YW_title,.Si12YW_intro,.Si12YW_subtitle,.Si12YW_notice,.Si12YW_error,.Si12YW_empty,.Si12YW_turnTitle,.Si12YW_turnPreview,.Si12YW_messageText{margin:0}.Si12YW_title{font-size:22px;font-weight:600;line-height:30px}.Si12YW_intro{max-width:700px;color:var(--dsw-alias-label-tertiary);margin-top:4px;font-size:13px;line-height:20px}.Si12YW_headerActions{flex:none;align-items:flex-end;gap:8px;display:flex}.Si12YW_cascadeField{color:var(--dsw-alias-label-secondary);flex-direction:column;gap:4px;font-size:11px;line-height:16px;display:flex}.Si12YW_select,.Si12YW_textarea,.Si12YW_primaryButton,.Si12YW_secondaryButton,.Si12YW_textButton,.Si12YW_versionButton{box-sizing:border-box;font:inherit}.Si12YW_select,.Si12YW_textarea{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-radius:8px}.Si12YW_select{height:34px;padding:0 30px 0 9px;font-size:12px}.Si12YW_primaryButton,.Si12YW_secondaryButton,.Si12YW_textButton,.Si12YW_versionButton{cursor:pointer;border:0}.Si12YW_primaryButton,.Si12YW_secondaryButton{border-radius:17px;justify-content:center;align-items:center;min-height:34px;padding:0 13px;font-size:12px;line-height:18px;display:inline-flex}.Si12YW_primaryButton{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill)}.Si12YW_primaryButton:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.Si12YW_secondaryButton{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}.Si12YW_secondaryButton:hover:not(:disabled),.Si12YW_textButton:hover:not(:disabled),.Si12YW_versionButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.Si12YW_primaryButton:disabled,.Si12YW_secondaryButton:disabled,.Si12YW_textButton:disabled,.Si12YW_versionButton:disabled,.Si12YW_select:disabled{cursor:default;opacity:.45}.Si12YW_primaryButton:focus-visible,.Si12YW_secondaryButton:focus-visible,.Si12YW_textButton:focus-visible,.Si12YW_versionButton:focus-visible,.Si12YW_select:focus-visible,.Si12YW_textarea:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}.Si12YW_notice,.Si12YW_error{max-width:1480px;margin:0 auto 10px;font-size:12px;line-height:18px}.Si12YW_notice{color:var(--dsw-alias-state-warn-label)}.Si12YW_error{color:var(--dsw-alias-state-error-primary)}.Si12YW_status{box-sizing:border-box;width:100%;height:100%;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);flex-direction:column;align-items:flex-start;gap:12px;padding:24px;display:flex}.Si12YW_status .Si12YW_error{margin:0}.Si12YW_columns{grid-template-columns:minmax(280px,.72fr) minmax(520px,1.75fr);align-items:start;gap:18px;max-width:1480px;margin:0 auto;display:grid}.Si12YW_versionsPanel,.Si12YW_turnsPanel{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;min-width:0;padding:16px}.Si12YW_versionsPanel{position:sticky;top:0}.Si12YW_sectionHeading{justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;display:flex}.Si12YW_effectControls{background:var(--dsw-alias-bg-module-platform);border-radius:9px;flex-direction:column;gap:8px;margin-bottom:12px;padding:10px;display:flex}.Si12YW_effectDepth{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}.Si12YW_effectButtons{flex-wrap:wrap;gap:6px;display:flex}.Si12YW_effectButtons .Si12YW_secondaryButton{min-height:28px;padding:0 10px;font-size:11px}.Si12YW_subtitle{font-size:16px;font-weight:500;line-height:24px}.Si12YW_count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.Si12YW_versionList,.Si12YW_turnList{margin:0;padding:0;list-style:none}.Si12YW_versionList{flex-direction:column;gap:4px;display:flex}.Si12YW_versionItem{--message-edit-depth:0;padding-left:calc(var(--message-edit-depth) * 14px);position:relative}.Si12YW_versionButton{width:100%;min-width:0;color:var(--dsw-alias-label-secondary);text-align:left;background:0 0;border-radius:9px;align-items:flex-start;gap:9px;padding:9px;display:flex;position:relative}.Si12YW_versionButton[data-current]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);opacity:1}.Si12YW_versionButton:not([data-current]) .Si12YW_pathBadge{opacity:.8}.Si12YW_versionLine{background:var(--dsw-alias-border-l2);width:1px;position:absolute;top:0;bottom:0;left:14px}.Si12YW_versionDot{z-index:1;border:2px solid var(--dsw-alias-bg-layer-1);background:var(--dsw-alias-label-tertiary);border-radius:50%;flex:none;width:7px;height:7px;margin-top:6px}.Si12YW_versionButton[data-current] .Si12YW_versionDot{border-color:var(--dsw-alias-bg-module-platform);background:var(--dsw-alias-brand-primary)}.Si12YW_versionMain{flex-direction:column;flex:1;min-width:0;display:flex}.Si12YW_versionTitle{text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}.Si12YW_versionMeta{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:16px;overflow:hidden}.Si12YW_versionDiff{color:var(--dsw-alias-label-tertiary);flex-direction:column;gap:2px;margin-top:5px;font-size:10px;line-height:15px;display:flex}.Si12YW_versionDiff span{-webkit-line-clamp:2;white-space:pre-wrap;overflow-wrap:anywhere;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}.Si12YW_currentBadge,.Si12YW_pathBadge,.Si12YW_kindBadge{border-radius:9px;flex:none;padding:1px 6px;font-size:10px;line-height:17px}.Si12YW_currentBadge{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}.Si12YW_pathBadge{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1)}.Si12YW_turnList{flex-direction:column;gap:14px;display:flex}.Si12YW_turnSection{border:1px solid var(--dsw-alias-border-l2);border-radius:11px;padding:13px}.Si12YW_turnHeader,.Si12YW_messageHeader,.Si12YW_editorActions{justify-content:space-between;align-items:center;gap:10px;display:flex}.Si12YW_turnHeader{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:flex-start;padding-bottom:11px}.Si12YW_turnTitle{font-size:14px;font-weight:500;line-height:22px}.Si12YW_turnPreview{max-width:700px;color:var(--dsw-alias-label-tertiary);-webkit-line-clamp:2;white-space:pre-wrap;-webkit-box-orient:vertical;font-size:11px;line-height:17px;display:-webkit-box;overflow:hidden}.Si12YW_messageList{flex-direction:column;gap:8px;margin-top:10px;display:flex}.Si12YW_messageCard{background:var(--dsw-alias-bg-module-platform);border-radius:9px;padding:10px}.Si12YW_messageHeader{justify-content:flex-start}.Si12YW_kindBadge{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}.Si12YW_kindBadge[data-kind=assistant\\.reasoning]{color:var(--dsw-alias-label-tertiary)}.Si12YW_messageTime{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:17px}.Si12YW_textButton{color:var(--dsw-alias-label-secondary);background:0 0;border-radius:12px;margin-left:auto;padding:3px 8px;font-size:11px;line-height:17px}.Si12YW_messageText{max-height:220px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;margin-top:7px;font-family:inherit;font-size:12px;line-height:19px;overflow:auto}.Si12YW_editor{margin-top:8px}.Si12YW_textarea{resize:vertical;width:100%;min-height:120px;padding:9px;font-size:12px;line-height:19px}.Si12YW_editorActions{margin-top:8px}.Si12YW_editorHint{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}.Si12YW_empty{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform);border-radius:10px;padding:18px;font-size:13px;line-height:20px}@media (width<=1000px){.Si12YW_columns{grid-template-columns:1fr}.Si12YW_versionsPanel{position:static}}@media (width<=680px){.Si12YW_root{padding:16px}.Si12YW_pageHeader,.Si12YW_headerActions,.Si12YW_turnHeader,.Si12YW_editorActions{flex-direction:column;align-items:stretch}.Si12YW_headerActions,.Si12YW_primaryButton,.Si12YW_secondaryButton{width:100%}}";
		const tagId = "@sh1robana/dsh-plugin-message-edit/MessageEditTimelineView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@sh1robana/dsh-plugin-message-edit";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var MessageEditTimelineView_module_css_default = {
			"versionItem": "Si12YW_versionItem",
			"error": "Si12YW_error",
			"versionButton": "Si12YW_versionButton",
			"secondaryButton": "Si12YW_secondaryButton",
			"versionsPanel": "Si12YW_versionsPanel",
			"headerActions": "Si12YW_headerActions",
			"textButton": "Si12YW_textButton",
			"versionTitle": "Si12YW_versionTitle",
			"pathBadge": "Si12YW_pathBadge",
			"versionDot": "Si12YW_versionDot",
			"versionList": "Si12YW_versionList",
			"kindBadge": "Si12YW_kindBadge",
			"messageCard": "Si12YW_messageCard",
			"turnHeader": "Si12YW_turnHeader",
			"turnPreview": "Si12YW_turnPreview",
			"effectDepth": "Si12YW_effectDepth",
			"messageTime": "Si12YW_messageTime",
			"effectButtons": "Si12YW_effectButtons",
			"empty": "Si12YW_empty",
			"messageList": "Si12YW_messageList",
			"root": "Si12YW_root",
			"versionLine": "Si12YW_versionLine",
			"textarea": "Si12YW_textarea",
			"select": "Si12YW_select",
			"count": "Si12YW_count",
			"cascadeField": "Si12YW_cascadeField",
			"status": "Si12YW_status",
			"turnTitle": "Si12YW_turnTitle",
			"columns": "Si12YW_columns",
			"turnSection": "Si12YW_turnSection",
			"editorActions": "Si12YW_editorActions",
			"editorHint": "Si12YW_editorHint",
			"intro": "Si12YW_intro",
			"sectionHeading": "Si12YW_sectionHeading",
			"turnList": "Si12YW_turnList",
			"currentBadge": "Si12YW_currentBadge",
			"messageHeader": "Si12YW_messageHeader",
			"title": "Si12YW_title",
			"turnsPanel": "Si12YW_turnsPanel",
			"effectControls": "Si12YW_effectControls",
			"primaryButton": "Si12YW_primaryButton",
			"versionDiff": "Si12YW_versionDiff",
			"editor": "Si12YW_editor",
			"messageText": "Si12YW_messageText",
			"subtitle": "Si12YW_subtitle",
			"versionMain": "Si12YW_versionMain",
			"notice": "Si12YW_notice",
			"pageHeader": "Si12YW_pageHeader",
			"versionMeta": "Si12YW_versionMeta"
		};
		//#endregion
		//#region src/client/MessageEditTimelineView.tsx
		/** Timeline tab: durable version tree plus turn/block edit and retry controls. */
		const BLOCK_LABEL = {
			user: "用户消息",
			"assistant.reasoning": "助手思考",
			"assistant.response": "助手回复"
		};
		const OPERATION_LABEL = {
			edit: "编辑",
			reroll: "重生成",
			retry: "重试"
		};
		function timeLabel(value) {
			return new Date(value).toLocaleString("zh-CN", {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit"
			});
		}
		function turnSections(turns, messages) {
			return turns.map((retry) => ({
				retry,
				messages: messages.filter((message) => message.turn === retry.turn)
			}));
		}
		function VersionRow({ version, disabled, onOpen }) {
			const depthStyle = { "--message-edit-depth": String(version.depth) };
			const operation = version.operation === void 0 ? version.parentSessionId === void 0 ? "原始版本" : "外部分支" : OPERATION_LABEL[version.operation];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
				className: MessageEditTimelineView_module_css_default["versionItem"],
				style: depthStyle,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: MessageEditTimelineView_module_css_default["versionButton"],
					"data-current": version.current || void 0,
					disabled: version.current || disabled,
					onClick: () => {
						onOpen(version.sessionId);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MessageEditTimelineView_module_css_default["versionLine"],
							"aria-hidden": true
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MessageEditTimelineView_module_css_default["versionDot"],
							"aria-hidden": true
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: MessageEditTimelineView_module_css_default["versionMain"],
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: MessageEditTimelineView_module_css_default["versionTitle"],
									children: [operation, version.targetTurn === void 0 ? null : ` · 回合 ${String(version.targetTurn)}`]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: MessageEditTimelineView_module_css_default["versionMeta"],
									children: [
										timeLabel(version.createdAt),
										" · ",
										version.sessionId.slice(0, 12)
									]
								}),
								version.before === void 0 && version.after === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: MessageEditTimelineView_module_css_default["versionDiff"],
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["原：", version.before || "（空）"] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["新：", version.after || "（空）"] })]
								})
							]
						}),
						version.current ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MessageEditTimelineView_module_css_default["currentBadge"],
							children: "当前"
						}) : version.onCurrentEffectPath ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MessageEditTimelineView_module_css_default["pathBadge"],
							children: "链上"
						}) : null
					]
				})
			});
		}
		function MessageCard({ message, disabled, onBeginEdit }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				className: MessageEditTimelineView_module_css_default["messageCard"],
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: MessageEditTimelineView_module_css_default["messageHeader"],
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: MessageEditTimelineView_module_css_default["kindBadge"],
								"data-kind": message.kind,
								children: BLOCK_LABEL[message.kind]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: MessageEditTimelineView_module_css_default["messageTime"],
								children: timeLabel(message.time)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: MessageEditTimelineView_module_css_default["textButton"],
								disabled,
								onClick: () => onBeginEdit(message),
								children: "编辑"
							})
						]
					}),
					message.attachments?.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: MessageEditTimelineView_module_css_default["messageTime"],
						children: ["附件：", message.attachments.map((item) => item.content.attachment.name ?? "图片附件").join("、")]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						className: MessageEditTimelineView_module_css_default["messageText"],
						children: message.text || "（空正文）"
					})
				]
			});
		}
		/** Conversation-view entry point. */
		function MessageEditTimelineView({ useMessageEdit, acquire, load, edit, retry, reroll, openVersion, attachmentTools, composerTools }) {
			const state = useMessageEdit((value) => value);
			const [cascade, setCascade] = (0, react.useState)("truncate");
			const [editing, setEditing] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				const release = acquire();
				load();
				return release;
			}, [acquire, load]);
			const timeline = state.timeline;
			const sections = (0, react.useMemo)(() => timeline === null ? [] : turnSections(timeline.retryableTurns, timeline.messages), [timeline]);
			const busy = state.pending !== null || state.status !== "ready";
			(0, react.useEffect)(() => {
				setEditing((current) => {
					if (current === null || timeline === null) return current;
					return timeline.messages.some((message) => message.key === current.message.key) ? current : null;
				});
			}, [timeline]);
			const cascadeRef = (0, react.useRef)(cascade);
			cascadeRef.current = cascade;
			(0, react.useEffect)(() => {
				if (editing === null) return;
				return mountEditor(editing.message, (message, text, _policy, regenerate, attachments, settings) => edit(message, text, cascadeRef.current, regenerate, attachments, settings), () => setEditing(null), attachmentTools, composerTools);
			}, [
				editing,
				edit,
				attachmentTools,
				composerTools
			]);
			if (timeline === null && (state.status === "idle" || state.status === "loading")) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: MessageEditTimelineView_module_css_default["status"],
				children: "正在载入消息时间线…"
			});
			if (timeline === null && state.status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: MessageEditTimelineView_module_css_default["status"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: MessageEditTimelineView_module_css_default["error"],
					children: state.error
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: MessageEditTimelineView_module_css_default["secondaryButton"],
					onClick: load,
					children: "重新载入"
				})]
			});
			if (timeline === null) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: MessageEditTimelineView_module_css_default["root"],
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: MessageEditTimelineView_module_css_default["pageHeader"],
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
							className: MessageEditTimelineView_module_css_default["title"],
							children: "消息编辑与重生成"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: MessageEditTimelineView_module_css_default["intro"],
							children: "每次修改都会与其恢复版本成对记录；回合及其完整工具链作为一个整体重新计算。"
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: MessageEditTimelineView_module_css_default["headerActions"],
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: MessageEditTimelineView_module_css_default["cascadeField"],
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "后续策略" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									className: MessageEditTimelineView_module_css_default["select"],
									value: cascade,
									disabled: busy,
									onChange: (event) => {
										setCascade(event.currentTarget.value);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "truncate",
										children: "截断后续（默认）"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "preserve",
										children: "保留输入并重生成后续"
									})]
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: MessageEditTimelineView_module_css_default["primaryButton"],
								disabled: busy,
								onClick: () => {
									reroll();
								},
								children: state.pending === "reroll" ? "正在重生成…" : "重生成最后回复"
							})]
						})]
					}),
					state.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: MessageEditTimelineView_module_css_default["error"],
						children: state.error
					}),
					state.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: MessageEditTimelineView_module_css_default["notice"],
						children: "正在刷新时间线…"
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: MessageEditTimelineView_module_css_default["columns"],
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
							className: MessageEditTimelineView_module_css_default["versionsPanel"],
							"aria-label": "版本时间线",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: MessageEditTimelineView_module_css_default["sectionHeading"],
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
										className: MessageEditTimelineView_module_css_default["subtitle"],
										children: "版本时间线"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: MessageEditTimelineView_module_css_default["count"],
										children: String(timeline.versions.length)
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: MessageEditTimelineView_module_css_default["effectControls"],
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: MessageEditTimelineView_module_css_default["effectDepth"],
										children: [
											"当前效果链 ",
											String(timeline.undoStack.length),
											" 层"
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: MessageEditTimelineView_module_css_default["effectButtons"],
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: MessageEditTimelineView_module_css_default["secondaryButton"],
											disabled: busy || timeline.undoStack[0] === void 0,
											onClick: () => {
												const target = timeline.undoStack[0];
												if (target !== void 0) openVersion(target);
											},
											children: "撤销当前效果"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: MessageEditTimelineView_module_css_default["secondaryButton"],
											disabled: busy || timeline.redoSessionIds.length === 0,
											onClick: () => {
												const target = timeline.redoSessionIds.at(-1);
												if (target !== void 0) openVersion(target);
											},
											children: timeline.redoSessionIds.length > 1 ? `重施加最新分支（${String(timeline.redoSessionIds.length)}）` : "重施加下一效果"
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
									className: MessageEditTimelineView_module_css_default["versionList"],
									children: timeline.versions.map((version) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(VersionRow, {
										version,
										disabled: busy,
										onOpen: (sessionId) => {
											openVersion(sessionId);
										}
									}, version.sessionId))
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("main", {
							className: MessageEditTimelineView_module_css_default["turnsPanel"],
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: MessageEditTimelineView_module_css_default["sectionHeading"],
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: MessageEditTimelineView_module_css_default["subtitle"],
									children: "已落定消息"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: MessageEditTimelineView_module_css_default["count"],
									children: String(timeline.messages.length)
								})]
							}), sections.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: MessageEditTimelineView_module_css_default["empty"],
								children: "当前会话还没有可编辑的已落定回合。"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
								className: MessageEditTimelineView_module_css_default["turnList"],
								children: sections.map((section) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: MessageEditTimelineView_module_css_default["turnSection"],
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: MessageEditTimelineView_module_css_default["turnHeader"],
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
											className: MessageEditTimelineView_module_css_default["turnTitle"],
											children: ["回合 ", String(section.retry.turn)]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: MessageEditTimelineView_module_css_default["turnPreview"],
											children: section.retry.preview || "（空用户输入）"
										})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: MessageEditTimelineView_module_css_default["secondaryButton"],
											disabled: busy,
											onClick: () => {
												retry(section.retry.turn, cascade);
											},
											children: state.pending === "retry" ? "正在重试…" : "重试此回合"
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: MessageEditTimelineView_module_css_default["messageList"],
										children: section.messages.map((message) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MessageCard, {
											message,
											disabled: busy,
											onBeginEdit: (value) => {
												setEditing({ message: value });
											}
										}, message.key))
									})]
								}, section.retry.turn))
							})]
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/UserMessageProjection.tsx
		const CHAT_NODE_SLOT = "conversation.chat.node";
		const USER_NODE_KEYS = ["user", "steering"];
		function equalContentValue(left, right) {
			if (left === right) return true;
			if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
			if (Array.isArray(left) !== Array.isArray(right)) return false;
			if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equalContentValue(value, right[index]));
			const leftRecord = left;
			const rightRecord = right;
			const keys = Object.keys(leftRecord);
			return keys.length === Object.keys(rightRecord).length && keys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && equalContentValue(leftRecord[key], rightRecord[key]));
		}
		function projectedRenderer(original) {
			const Original = original.component;
			return function UserMessageProjection(props) {
				const { acquire, load, node, useMessageEdit } = props;
				const messages = useMessageEdit((state) => state.timeline?.messages);
				(0, react.useEffect)(() => {
					const release = acquire();
					load();
					return release;
				}, [acquire, load]);
				const savedContent = messages?.find((message) => message.kind === "user" && message.eventSeq === node.data.seq && message.content !== void 0)?.content;
				let projected = node;
				if (savedContent !== void 0) {
					if (!equalContentValue(node.data.content, savedContent)) projected = {
						...node,
						data: {
							...node.data,
							content: savedContent
						}
					};
				} else {
					let changed = false;
					const content = node.data.content.map((block, blockIndex) => {
						if (block.type !== "text") return block;
						const saved = messages?.find((message) => message.kind === "user" && message.eventSeq === node.data.seq && message.blockIndex === blockIndex);
						if (saved === void 0 || saved.text === block.text) return block;
						changed = true;
						return {
							...block,
							text: saved.text
						};
					});
					if (changed) projected = {
						...node,
						data: {
							...node.data,
							content
						}
					};
				}
				return (0, react.createElement)(Original, {
					...props,
					node: projected
				});
			};
		}
		/** 覆写用户消息的显示内容，复用官方气泡、附件和复制操作，不修改宿主的只读事件源。 */
		function registerUserMessageProjection(ctx, faceFor) {
			const slots = ctx.slots;
			if (typeof slots.entries !== "function" || typeof slots.subscribe !== "function") return;
			ctx.effect(() => {
				const active = /* @__PURE__ */ new Map();
				let disposed = false;
				const sync = () => {
					if (disposed) return;
					for (const key of USER_NODE_KEYS) {
						const current = active.get(key);
						const original = slots.entries(CHAT_NODE_SLOT).find((entry) => entry.options.key === key && !Array.from(active.values()).some((wrapper) => wrapper.component === entry.component));
						if (current?.original === original) continue;
						current?.dispose();
						active.delete(key);
						if (original === void 0) continue;
						const component = projectedRenderer(original);
						const dispose = slots.register({
							name: CHAT_NODE_SLOT,
							key,
							priority: (original.options.priority ?? 0) - 1,
							...original.locale === void 0 ? {} : { locale: original.locale },
							inject: faceFor
						}, component);
						active.set(key, {
							original,
							component,
							dispose
						});
					}
				};
				const unsubscribe = slots.subscribe(CHAT_NODE_SLOT, sync);
				sync();
				return () => {
					disposed = true;
					unsubscribe();
					for (const wrapper of active.values()) wrapper.dispose();
					active.clear();
				};
			}, "message-edit: 用户消息显示投影");
		}
		//#endregion
		//#region src/client/index.ts
		/** Explicit value sources and slot declaration-order edges. */
		const inject = [
			"slots",
			"uiConversation",
			"conversation",
			"uiWorkspace",
			"connection",
			"sessions",
			"commandUi",
			"remote.commands",
			"remote.sessionReferenceResolver"
		];
		/** Register both UI contributions over one per-session controller identity. */
		function apply(ctx) {
			const globals = globalThis;
			const diagnostics = Object.freeze({
				build: MESSAGE_EDIT_BUILD_INFO,
				diagnostics: async () => {
					const response = await hostFetch(`${MESSAGE_EDIT_PATH}?view=diagnostics`, {
						method: "GET",
						headers: { accept: "application/json" },
						cache: "no-store"
					});
					if (!response.ok) throw new Error(`无法读取插件诊断：HTTP ${String(response.status)}`);
					const host = await response.json();
					return {
						client: MESSAGE_EDIT_BUILD_INFO,
						host,
						matched: host.build?.version === MESSAGE_EDIT_BUILD_INFO.version && host.build?.buildId === MESSAGE_EDIT_BUILD_INFO.buildId
					};
				}
			});
			ctx.effect(() => {
				const previous = globals.__DSH_MESSAGE_EDIT__;
				globals.__DSH_MESSAGE_EDIT__ = diagnostics;
				return () => {
					if (globals.__DSH_MESSAGE_EDIT__ === diagnostics) if (previous === void 0) delete globals.__DSH_MESSAGE_EDIT__;
					else globals.__DSH_MESSAGE_EDIT__ = previous;
				};
			}, "message-edit: 构建诊断");
			const controllers = /* @__PURE__ */ new Map();
			const controllerFor = (sessionId) => {
				let controller = controllers.get(sessionId);
				if (controller === void 0) {
					controller = new MessageEditController(ctx, sessionId);
					controllers.set(sessionId, controller);
				}
				return controller;
			};
			registerUserMessageProjection(ctx, (sessionId) => controllerFor(sessionId).face);
			ctx.on("connection/reset", () => {
				for (const controller of controllers.values()) controller.refreshIfLoaded();
			});
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "message-edit-timeline",
				order: 15,
				label: "Timeline",
				inject: (sessionId) => controllerFor(sessionId).face
			}, MessageEditTimelineView));
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "message-edit-controls",
				order: 15,
				inject: (sessionId) => controllerFor(sessionId).face
			}, MessageEditHeader));
		}
		//#endregion
		exports.MESSAGE_EDIT_BUILD_INFO = MESSAGE_EDIT_BUILD_INFO;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map