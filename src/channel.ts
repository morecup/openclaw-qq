import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ReplyPayload,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk";
import { OneBotClient } from "./client.js";
import { QQConfigSchema, type QQConfig } from "./config.js";
import { getQQRuntime } from "./runtime.js";
import type { OneBotMessage, OneBotMessageSegment } from "./types.js";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
};

const memberCache = new Map<string, { name: string, time: number }>();

function getCachedMemberName(groupId: string, userId: string): string | null {
    const key = `${groupId}:${userId}`;
    const cached = memberCache.get(key);
    if (cached && Date.now() - cached.time < 3600000) { // 1 hour cache
        return cached.name;
    }
    return null;
}

function setCachedMemberName(groupId: string, userId: string, name: string) {
    memberCache.set(`${groupId}:${userId}`, { name, time: Date.now() });
}

function extractImageUrls(message: OneBotMessage | string | undefined, maxImages = 3): string[] {
  if (!message || typeof message === "string") return [];
  
  const urls: string[] = [];
  for (const segment of message) {
    if (segment.type === "image") {
      const url = segment.data?.url || segment.data?.file;
      if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
        urls.push(url);
        if (urls.length >= maxImages) break;
      }
    }
  }
  return urls;
}

function cleanCQCodes(text: string | undefined): string {
  if (!text) return "";
  
  let result = text;
  const imageUrls: string[] = [];
  
  const imageRegex = /\[CQ:image,[^\]]*url=([^,\]]+)[^\]]*\]/g;
  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    const url = match[1].replace(/&amp;/g, "&");
    imageUrls.push(url);
  }

  result = result.replace(/\[CQ:face,id=(\d+)\]/g, "[表情]");
  
  result = result.replace(/\[CQ:[^\]]+\]/g, (match) => {
    if (match.startsWith("[CQ:image") && match.includes("url=")) {
      return "[图片]";
    }
    return "";
  });
  
  result = result.replace(/\s+/g, " ").trim();
  
  if (imageUrls.length > 0) {
    result = result ? `${result} [图片: ${imageUrls.join(", ")}]` : `[图片: ${imageUrls.join(", ")}]`;
  }
  
  return result;
}

function getReplyMessageId(message: OneBotMessage | string | undefined, rawMessage?: string): string | null {
  if (message && typeof message !== "string") {
    for (const segment of message) {
      if (segment.type === "reply" && segment.data?.id) {
        const id = String(segment.data.id).trim();
        if (id && /^-?\d+$/.test(id)) {
          return id;
        }
      }
    }
  }
  if (rawMessage) {
    const match = rawMessage.match(/\[CQ:reply,id=(\d+)\]/);
    if (match) return match[1];
  }
  return null;
}

function normalizeTarget(raw: string): string {
  return raw.replace(/^(qq:)/i, "");
}

const clients = new Map<string, OneBotClient>();

function getClientForAccount(accountId: string) {
    return clients.get(accountId);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isImageFile(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.gif') || lower.endsWith('.webp');
}

function splitMessage(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const chunks = [];
    let current = text;
    while (current.length > 0) {
        chunks.push(current.slice(0, limit));
        current = current.slice(limit);
    }
    return chunks;
}

function stripMarkdown(text: string): string {
    return text
        .replace(/\*\*(.*?)\*\*/g, "$1") // Bold
        .replace(/\*(.*?)\*/g, "$1")     // Italic
        .replace(/`(.*?)`/g, "$1")       // Inline code
        .replace(/#+\s+(.*)/g, "$1")     // Headers
        .replace(/\[(.*?)\]\(.*?\)/g, "$1") // Links
        .replace(/^\s*>\s+(.*)/gm, "▎$1") // Blockquotes
        .replace(/```[\s\S]*?```/g, "[代码块]") // Code blocks
        .replace(/^\|.*\|$/gm, (match) => { // Simple table row approximation
             return match.replace(/\|/g, " ").trim();
        })
        .replace(/^[\-\*]\s+/gm, "• "); // Lists
}

function processAntiRisk(text: string): string {
    return text.replace(/(https?:\/\/)/gi, "$1 ");
}

async function resolveMediaUrl(url: string): Promise<string> {
    // Handle file:// URLs
    if (url.startsWith("file:")) {
        try {
            const filePath = fileURLToPath(url);
            const data = await fs.readFile(filePath);
            const ext = filePath.split('.').pop()?.toLowerCase() || 'png';
            const base64 = data.toString("base64");
            return `base64://${base64}`;
        } catch (e) {
            console.warn(`[QQ] Failed to convert local file to base64: ${e}`);
            return url;
        }
    }
    // Handle absolute local paths (e.g. /tmp/screenshot.png)
    if (url.startsWith("/") && !url.startsWith("//")) {
        try {
            const data = await fs.readFile(url);
            const base64 = data.toString("base64");
            return `base64://${base64}`;
        } catch (e) {
            console.warn(`[QQ] Failed to convert absolute path to base64: ${e}`);
            return url;
        }
    }
    // Handle relative paths (e.g. ./screenshot.png)
    if (url.startsWith("./") || url.startsWith("../")) {
        try {
            const data = await fs.readFile(url);
            const base64 = data.toString("base64");
            return `base64://${base64}`;
        } catch (e) {
            console.warn(`[QQ] Failed to convert relative path to base64: ${e}`);
            return url;
        }
    }
    return url;
}

const QQ_FILES_DIR = "/tmp/openclaw-qq-files";

async function ensureFilesDir(): Promise<void> {
    await fs.mkdir(QQ_FILES_DIR, { recursive: true });
}

function sanitizeFilename(name: string): string {
    return name.replace(/[^\w\u4e00-\u9fff.\-()（）]/g, "_").slice(0, 200);
}

async function downloadFile(url: string, filename: string): Promise<string | null> {
    try {
        await ensureFilesDir();
        const safeName = sanitizeFilename(filename);
        const timestamp = Date.now();
        const destPath = path.join(QQ_FILES_DIR, `${timestamp}_${safeName}`);

        // Handle local file paths (file:// or absolute path)
        if (url.startsWith("file://")) {
            try {
                const localSrc = fileURLToPath(url);
                await fs.copyFile(localSrc, destPath);
                console.log(`[QQ] File copied: ${localSrc} -> ${destPath}`);
                return destPath;
            } catch (err) {
                console.warn(`[QQ] File copy failed: ${err}`);
                return null;
            }
        }
        if (url.startsWith("/")) {
            try {
                await fs.copyFile(url, destPath);
                console.log(`[QQ] File copied: ${url} -> ${destPath}`);
                return destPath;
            } catch (err) {
                console.warn(`[QQ] File copy failed: ${err}`);
                return null;
            }
        }

        // HTTP(S) download
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            console.warn(`[QQ] Unsupported file URL scheme: ${url.slice(0, 50)}`);
            return null;
        }

        const get = url.startsWith("https") ? https.get : http.get;

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.warn("[QQ] File download timeout:", filename);
                resolve(null);
            }, 30000);

            const req = get(url, { timeout: 25000 }, (res) => {
                // Follow redirects (up to 3)
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    clearTimeout(timeout);
                    downloadFile(res.headers.location, filename).then(resolve);
                    return;
                }

                if (res.statusCode !== 200) {
                    clearTimeout(timeout);
                    console.warn(`[QQ] File download failed: HTTP ${res.statusCode} for ${filename}`);
                    resolve(null);
                    return;
                }

                const ws = createWriteStream(destPath);
                pipeline(res, ws)
                    .then(() => {
                        clearTimeout(timeout);
                        console.log(`[QQ] File downloaded: ${filename} -> ${destPath}`);
                        resolve(destPath);
                    })
                    .catch((err) => {
                        clearTimeout(timeout);
                        console.warn(`[QQ] File write failed: ${err}`);
                        resolve(null);
                    });
            });

            req.on("error", (err) => {
                clearTimeout(timeout);
                console.warn(`[QQ] File download error: ${err}`);
                resolve(null);
            });
        });
    } catch (err) {
        console.warn(`[QQ] downloadFile exception: ${err}`);
        return null;
    }
}

async function getFileUrl(client: OneBotClient, seg: any, isGroup: boolean, groupId?: number): Promise<string | null> {
    // 1. URL already present in segment data
    if (seg.data?.url) return seg.data.url;

    // 2. Group file: use get_group_file_url
    if (isGroup && groupId && seg.data?.file_id) {
        try {
            const info = await client.sendWithResponse("get_group_file_url", {
                group_id: groupId,
                file_id: seg.data.file_id,
                busid: seg.data.busid,
            });
            if (info?.url) return info.url;
        } catch (e) {
            console.warn(`[QQ] get_group_file_url failed:`, e);
        }
    }

    // 3. NapCat extended API: /get_file (works for private & group)
    if (seg.data?.file_id) {
        try {
            const info = await client.sendWithResponse("get_file", {
                file_id: seg.data.file_id,
            });
            if (info?.url) return info.url;
            if (info?.file) return `file://${info.file}`;
        } catch (e) {
            console.warn(`[QQ] get_file failed:`, e);
        }
    }

    // 4. Try file field as URL directly
    if (seg.data?.file && (seg.data.file.startsWith("http://") || seg.data.file.startsWith("https://"))) {
        return seg.data.file;
    }

    return null;
}

export const qqChannel: ChannelPlugin<ResolvedQQAccount> = {
  id: "qq",
  meta: {
    id: "qq",
    label: "QQ (OneBot)",
    selectionLabel: "QQ",
    docsPath: "extensions/qq",
    blurb: "Connect to QQ via OneBot v11",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    // @ts-ignore
    deleteMessage: true,
  },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg) => {
        // @ts-ignore
        const qq = cfg.channels?.qq;
        if (!qq) return [];
        if (qq.accounts) return Object.keys(qq.accounts);
        return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => {
        const id = accountId ?? DEFAULT_ACCOUNT_ID;
        // @ts-ignore
        const qq = cfg.channels?.qq;
        const accountConfig = id === DEFAULT_ACCOUNT_ID ? qq : qq?.accounts?.[id];
        return {
            accountId: id,
            name: accountConfig?.name ?? "QQ Default",
            enabled: true,
            configured: Boolean(accountConfig?.wsUrl),
            tokenSource: accountConfig?.accessToken ? "config" : "none",
            config: accountConfig || {},
        };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    describeAccount: (acc) => ({
        accountId: acc.accountId,
        configured: acc.configured,
    }),
  },
  directory: {
      listPeers: async ({ accountId }) => {
          const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          try {
              const friends = await client.getFriendList();
              return friends.map(f => ({
                  id: String(f.user_id),
                  name: f.remark || f.nickname,
                  type: "user" as const,
                  metadata: { ...f }
              }));
          } catch (e) {
              return [];
          }
      },
      listGroups: async ({ accountId, cfg }) => {
          const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          const list: any[] = [];
          
          try {
              const groups = await client.getGroupList();
              list.push(...groups.map(g => ({
                  id: String(g.group_id),
                  name: g.group_name,
                  type: "group" as const,
                  metadata: { ...g }
              })));
          } catch (e) {}

          // @ts-ignore
          const enableGuilds = cfg?.channels?.qq?.enableGuilds ?? true;
          if (enableGuilds) {
              try {
                  const guilds = await client.getGuildList();
                  list.push(...guilds.map(g => ({
                      id: `guild:${g.guild_id}`,
                      name: `[频道] ${g.guild_name}`,
                      type: "group" as const,
                      metadata: { ...g }
                  })));
              } catch (e) {}
          }
          return list;
      }
  },
  status: {
      probeAccount: async ({ account, timeoutMs }) => {
          if (!account.config.wsUrl) return { ok: false, error: "Missing wsUrl" };
          
          const client = new OneBotClient({
              wsUrl: account.config.wsUrl,
              accessToken: account.config.accessToken,
          });
          
          return new Promise((resolve) => {
              const timer = setTimeout(() => {
                  client.disconnect();
                  resolve({ ok: false, error: "Connection timeout" });
              }, timeoutMs || 5000);

              client.on("connect", async () => {
                  try {
                      const info = await client.getLoginInfo();
                      clearTimeout(timer);
                      client.disconnect();
                      resolve({ 
                          ok: true, 
                          bot: { id: String(info.user_id), username: info.nickname } 
                      });
                  } catch (e) {
                      clearTimeout(timer);
                      client.disconnect();
                      resolve({ ok: false, error: String(e) });
                  }
              });
              
              client.on("error", (err) => {
                  clearTimeout(timer);
                  resolve({ ok: false, error: String(err) });
              });

              client.connect();
          });
      },
      buildAccountSnapshot: ({ account, runtime, probe }) => {
          return {
              accountId: account.accountId,
              name: account.name,
              enabled: account.enabled,
              configured: account.configured,
              running: runtime?.running ?? false,
              lastStartAt: runtime?.lastStartAt ?? null,
              lastError: runtime?.lastError ?? null,
              probe,
          };
      }
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => 
        applyAccountNameToChannelSection({ cfg, channelKey: "qq", accountId, name }),
    validateInput: ({ input }) => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
        const namedConfig = applyAccountNameToChannelSection({
            cfg,
            channelKey: "qq",
            accountId,
            name: input.name,
        });
        
        const next = accountId !== DEFAULT_ACCOUNT_ID 
            ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "qq" }) 
            : namedConfig;

        const newConfig = {
            wsUrl: input.wsUrl || "ws://localhost:3001",
            accessToken: input.accessToken,
            enabled: true,
        };

        if (accountId === DEFAULT_ACCOUNT_ID) {
            return {
                ...next,
                channels: {
                    ...next.channels,
                    qq: { ...next.channels?.qq, ...newConfig }
                }
            };
        }
        
        return {
            ...next,
            channels: {
                ...next.channels,
                qq: {
                    ...next.channels?.qq,
                    enabled: true,
                    accounts: {
                        ...next.channels?.qq?.accounts,
                        [accountId]: {
                            ...next.channels?.qq?.accounts?.[accountId],
                            ...newConfig
                        }
                    }
                }
            }
        };
    }
  },
  gateway: {
    startAccount: async (ctx) => {
        const { account, cfg } = ctx;
        const config = account.config;

        if (!config.wsUrl) throw new Error("QQ: wsUrl is required");

        // Clean up any existing client before creating a new one
        const existingClient = clients.get(account.accountId);
        if (existingClient) {
            console.log(`[QQ] Cleaning up existing client for account ${account.accountId}`);
            existingClient.disconnect();
            clients.delete(account.accountId);
        }

        const client = new OneBotClient({
            wsUrl: config.wsUrl,
            accessToken: config.accessToken,
        });
        
        clients.set(account.accountId, client);

        const processedMsgIds = new Set<string>();
        const cleanupInterval = setInterval(() => {
            if (processedMsgIds.size > 1000) processedMsgIds.clear();
        }, 3600000);

        client.on("connect", async () => {
             console.log(`[QQ] Connected account ${account.accountId}`);
             try {
                const info = await client.getLoginInfo();
                if (info && info.nickname) console.log(`[QQ] Logged in as: ${info.nickname} (${info.user_id})`);
                getQQRuntime().channel.activity.record({
                    channel: "qq", accountId: account.accountId, direction: "inbound", 
                 });
             } catch (err) { }
        });

        client.on("request", (event) => {
            if (config.autoApproveRequests) {
                if (event.request_type === "friend") client.setFriendAddRequest(event.flag, true);
                else if (event.request_type === "group") client.setGroupAddRequest(event.flag, event.sub_type, true);
            }
        });

        client.on("message", async (event) => {
            // Debug: log non-heartbeat events
            if (event.post_type !== "meta_event") {
                console.log(`[QQ-DEBUG] event: post_type=${event.post_type}, notice_type=${(event as any).notice_type || "-"}, message_type=${event.message_type || "-"}, sub_type=${event.sub_type || "-"}`);
                if (event.post_type === "notice" || !event.post_type) {
                    console.log(`[QQ-DEBUG] full event:`, JSON.stringify(event).slice(0, 1000));
                }
            }

            if (event.post_type === "meta_event") {
                 if (event.meta_event_type === "lifecycle" && event.sub_type === "connect" && event.self_id) client.setSelfId(event.self_id);
                 return;
            }

            if (event.post_type === "notice" && event.notice_type === "notify" && event.sub_type === "poke") {
                if (String(event.target_id) === String(client.getSelfId())) {
                    event.post_type = "message";
                    event.message_type = event.group_id ? "group" : "private";
                    event.raw_message = `[动作] 用户戳了你一下`;
                    event.message = [{ type: "text", data: { text: event.raw_message } }];
                } else return;
            }

            // Handle private file transfer (offline_file notice)
            if (event.post_type === "notice" && (event as any).notice_type === "offline_file") {
                const fileInfo = (event as any).file;
                if (fileInfo) {
                    const fileName = fileInfo.name || "未命名";
                    const fileUrl = fileInfo.url;
                    let fileText = `[文件: ${fileName}]`;
                    if (fileUrl) {
                        const localPath = await downloadFile(fileUrl, fileName);
                        if (localPath) {
                            fileText = `[文件: ${fileName}]\n[文件已下载: ${localPath}]`;
                        } else {
                            fileText = `[文件: ${fileName}] (下载失败)`;
                        }
                    }
                    event.post_type = "message";
                    event.message_type = "private";
                    event.raw_message = fileText;
                    event.message = [{ type: "text", data: { text: fileText } }];
                    console.log(`[QQ] Offline file received: ${fileName}, url: ${fileUrl ? "yes" : "no"}`);
                } else return;
            }

            // Handle group file upload (group_upload notice)
            if (event.post_type === "notice" && (event as any).notice_type === "group_upload") {
                const fileInfo = (event as any).file;
                if (fileInfo) {
                    const fileName = fileInfo.name || "未命名";
                    let fileUrl = fileInfo.url;
                    // Try to get URL via API if not present
                    if (!fileUrl && fileInfo.id) {
                        try {
                            const info = await client.sendWithResponse("get_group_file_url", {
                                group_id: event.group_id,
                                file_id: fileInfo.id,
                                busid: fileInfo.busid,
                            });
                            if (info?.url) fileUrl = info.url;
                        } catch (e) {
                            console.warn(`[QQ] get_group_file_url failed for notice:`, e);
                        }
                    }
                    let fileText = `[文件: ${fileName}]`;
                    if (fileUrl) {
                        const localPath = await downloadFile(fileUrl, fileName);
                        if (localPath) {
                            fileText = `[文件: ${fileName}]\n[文件已下载: ${localPath}]`;
                        } else {
                            fileText = `[文件: ${fileName}] (下载失败)`;
                        }
                    }
                    event.post_type = "message";
                    event.message_type = "group";
                    event.raw_message = fileText;
                    event.message = [{ type: "text", data: { text: fileText } }];
                    console.log(`[QQ] Group file upload: ${fileName}, url: ${fileUrl ? "yes" : "no"}`);
                } else return;
            }

            if (event.post_type !== "message") return;

            // Skip messages from the bot itself (echo / self-sent)
            const selfId = client.getSelfId() ?? event.self_id;
            if (selfId && String(event.user_id) === String(selfId)) {
                console.debug(`[QQ] Ignoring message from self (user_id=${event.user_id})`);
                return;
            }

            if ([2854196310].includes(event.user_id)) return;

            // Ignore empty message events (NapCat/QQ client actions like file download can emit these)
            const rawTrimmed = (event.raw_message || "").trim();
            const segLen = Array.isArray(event.message) ? event.message.length : 0;
            if (!rawTrimmed && segLen === 0) {
                console.debug(`[QQ] Ignoring empty message event (message_id=${event.message_id || "-"})`);
                return;
            }

            if (config.enableDeduplication !== false && event.message_id) {
                const msgIdKey = String(event.message_id);
                if (processedMsgIds.has(msgIdKey)) return;
                processedMsgIds.add(msgIdKey);
            }

            const isGroup = event.message_type === "group";
            const isGuild = event.message_type === "guild";
            
            if (isGuild && !config.enableGuilds) return;

            const userId = event.user_id;
            const groupId = event.group_id;
            const guildId = event.guild_id;
            const channelId = event.channel_id;
            
            // Resolve per-group effective settings
            const groupOverride = isGroup && groupId ? config.groupSettings?.[String(groupId)] : undefined;
            const effectiveRequireMention = groupOverride?.requireMention ?? config.requireMention;
            const effectiveHistoryLimit = groupOverride?.historyLimit ?? config.historyLimit ?? 5;
            
            let text = event.raw_message || "";
            
            if (Array.isArray(event.message)) {
                let resolvedText = "";
                for (const seg of event.message) {
                    if (seg.type === "text") resolvedText += seg.data?.text || "";
                    else if (seg.type === "at") {
                        let name = seg.data?.qq;
                        if (name !== "all" && isGroup) {
                            const cached = getCachedMemberName(String(groupId), String(name));
                            if (cached) name = cached;
                            else {
                                try {
                                    const info = await (client as any).sendWithResponse("get_group_member_info", { group_id: groupId, user_id: name });
                                    name = info?.card || info?.nickname || name;
                                    setCachedMemberName(String(groupId), String(seg.data.qq), name);
                                } catch (e) {}
                            }
                        }
                        resolvedText += ` @${name} `;
                    } else if (seg.type === "record") resolvedText += ` [语音消息]${seg.data?.text ? `(${seg.data.text})` : ""}`;
                    else if (seg.type === "video") resolvedText += " [视频消息]";
                    else if (seg.type === "json") resolvedText += " [卡片消息]";
                    else if (seg.type === "forward" && seg.data?.id) {
                        try {
                            const forwardData = await client.getForwardMsg(seg.data.id);
                            if (forwardData?.messages) {
                                resolvedText += "\n[转发聊天记录]:";
                                for (const m of forwardData.messages.slice(0, 10)) {
                                    resolvedText += `\n${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.content || m.raw_message)}`;
                                }
                            }
                        } catch (e) {}
                    } else if (seg.type === "file") {
                         const fileName = seg.data?.file || seg.data?.name || "未命名";
                         console.log(`[QQ-DEBUG] file segment data:`, JSON.stringify(seg.data || {}).slice(0, 500));
                         const fileUrl = await getFileUrl(client, seg, isGroup, groupId);
                         console.log(`[QQ-DEBUG] resolved fileUrl: ${fileUrl?.slice(0, 200) || "null"}`);
                         if (fileUrl) {
                             const localPath = await downloadFile(fileUrl, fileName);
                             if (localPath) {
                                 resolvedText += ` [文件: ${fileName}]\n[文件已下载: ${localPath}]`;
                             } else {
                                 resolvedText += ` [文件: ${fileName}] (下载失败, URL: ${fileUrl})`;
                             }
                         } else {
                             resolvedText += ` [文件: ${fileName}] (无法获取下载链接)`;
                         }
                    }
                }
                if (resolvedText) text = resolvedText;
            }
            
            if (config.blockedUsers?.includes(userId)) return;
            if (isGroup && config.allowedGroups?.length && !config.allowedGroups.includes(groupId)) return;
            
            const isAdmin = config.admins?.includes(userId) ?? false;
            if (config.admins?.length && !isAdmin) return;

            if (!isGuild && isAdmin && text.trim().startsWith('/')) {
                const parts = text.trim().split(/\s+/);
                const cmd = parts[0];
                if (cmd === '/status') {
                    const statusMsg = `[OpenClawd QQ]\nState: Connected\nSelf ID: ${client.getSelfId()}\nMemory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`;
                    if (isGroup) client.sendGroupMsg(groupId, statusMsg); else client.sendPrivateMsg(userId, statusMsg);
                    return;
                }
                if (cmd === '/help') {
                    const helpMsg = `[OpenClawd QQ]\n/status - 状态\n/mute @用户 [分] - 禁言\n/kick @用户 - 踢出\n/help - 帮助`;
                    if (isGroup) client.sendGroupMsg(groupId, helpMsg); else client.sendPrivateMsg(userId, helpMsg);
                    return;
                }
                if (isGroup && (cmd === '/mute' || cmd === '/ban')) {
                    const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                    const targetId = targetMatch ? parseInt(targetMatch[1]) : (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        client.setGroupBan(groupId, targetId, parts[2] ? parseInt(parts[2]) * 60 : 1800);
                        client.sendGroupMsg(groupId, `已禁言。`);
                    }
                    return;
                }
                if (isGroup && cmd === '/kick') {
                    const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                    const targetId = targetMatch ? parseInt(targetMatch[1]) : (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        client.setGroupKick(groupId, targetId);
                        client.sendGroupMsg(groupId, `已踢出。`);
                    }
                    return;
                }
            }
            
            let repliedMsg: any = null;
            const replyMsgId = getReplyMessageId(event.message, text);
            if (replyMsgId) {
                try { repliedMsg = await client.getMsg(replyMsgId); } catch (err) {}
            }
            
            let historyContext = "";
            if (isGroup && effectiveRequireMention && effectiveHistoryLimit !== 0) {
                 try {
                     const history = await client.getGroupMsgHistory(groupId);
                     if (history?.messages) {
                         historyContext = history.messages.slice(-(effectiveHistoryLimit + 1), -1).map((m: any) => `${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.raw_message || "")}`).join("\n");
                     }
                 } catch (e) {}
            }

            let isTriggered = !isGroup || text.includes("[动作] 用户戳了你一下");
            if (!isTriggered && config.keywordTriggers) {
                for (const kw of config.keywordTriggers) { if (text.includes(kw)) { isTriggered = true; break; } }
            }
            
            const checkMention = isGroup || isGuild;
            if (checkMention && effectiveRequireMention && !isTriggered) {
                const selfId = client.getSelfId();
                const effectiveSelfId = selfId ?? event.self_id;
                if (!effectiveSelfId) return;
                let mentioned = false;
                if (Array.isArray(event.message)) {
                    for (const s of event.message) { if (s.type === "at" && (String(s.data?.qq) === String(effectiveSelfId) || s.data?.qq === "all")) { mentioned = true; break; } }
                } else if (text.includes(`[CQ:at,qq=${effectiveSelfId}]`)) mentioned = true;
                if (!mentioned && repliedMsg?.sender?.user_id === effectiveSelfId) mentioned = true;
                if (!mentioned) return;
            }

            let fromId = String(userId);
            let conversationLabel = `QQ User ${userId}`;
            if (isGroup) {
                fromId = `group:${groupId}`;
                conversationLabel = `QQ Group ${groupId}`;
            } else if (isGuild) {
                fromId = `guild:${guildId}:${channelId}`;
                conversationLabel = `QQ Guild ${guildId} Channel ${channelId}`;
            }

            const runtime = getQQRuntime();

            const deliver = async (payload: ReplyPayload) => {
                 // Collect and resolve media URLs
                 const rawMediaUrls = (payload as any).mediaUrls ?? ((payload as any).mediaUrl ? [(payload as any).mediaUrl] : []);
                 const resolvedMedia: { url: string; rawUrl: string; isImage: boolean }[] = [];
                 for (let rawUrl of rawMediaUrls) {
                     if (!rawUrl) continue;
                     try {
                         if (rawUrl.startsWith("./") || rawUrl.startsWith("../")) {
                             const workspace = runtime.config?.agents?.defaults?.workspace || '/root/.openclaw/workspace';
                             rawUrl = path.resolve(workspace, rawUrl);
                         }
                         const url = await resolveMediaUrl(rawUrl);
                         resolvedMedia.push({ url, rawUrl, isImage: isImageFile(url) || isImageFile(rawUrl) });
                     } catch(err: any) {
                         console.warn(`[QQ] Failed to resolve media ${rawUrl}:`, err?.message);
                     }
                 }
                 // Also collect from payload.files (legacy path)
                 if (payload.files) {
                     for (const f of payload.files) {
                         if (f.url) {
                             try {
                                 const url = await resolveMediaUrl(f.url);
                                 resolvedMedia.push({ url, rawUrl: f.url, isImage: isImageFile(url) });
                             } catch(err: any) {
                                 console.warn(`[QQ] Failed to resolve file ${f.url}:`, err?.message);
                             }
                         }
                     }
                 }

                 const imageMedia = resolvedMedia.filter(m => m.isImage);
                 const fileMedia = resolvedMedia.filter(m => !m.isImage);
                 const hasText = Boolean(payload.text?.trim());

                 // Combined send: text + images in one message (with @ in groups)
                 if (hasText && imageMedia.length > 0) {
                     let processed = payload.text!;
                     if (config.formatMarkdown) processed = stripMarkdown(processed);
                     if (config.antiRiskMode) processed = processAntiRisk(processed);
                     const segments: any[] = [];
                     if (isGroup) segments.push({ type: "at", data: { qq: String(userId) } });
                     segments.push({ type: "text", data: { text: isGroup ? ` ${processed}` : processed } });
                     for (const m of imageMedia) {
                         segments.push({ type: "image", data: { file: m.url } });
                     }
                     if (isGroup) await client.sendGroupMsg(groupId, segments);
                     else if (isGuild) await client.sendGuildChannelMsg(guildId, channelId, segments);
                     else await client.sendPrivateMsg(userId, segments);
                 } else if (hasText) {
                     // Text only: use original chunked send with @
                     let processed = payload.text!;
                     if (config.formatMarkdown) processed = stripMarkdown(processed);
                     if (config.antiRiskMode) processed = processAntiRisk(processed);
                     const chunks = splitMessage(processed, config.maxMessageLength || 4000);
                     for (let i = 0; i < chunks.length; i++) {
                         let chunk = chunks[i];
                         if (isGroup && i === 0) chunk = `[CQ:at,qq=${userId}] ${chunk}`;
                         if (isGroup) await client.sendGroupMsg(groupId, chunk);
                         else if (isGuild) await client.sendGuildChannelMsg(guildId, channelId, chunk);
                         else await client.sendPrivateMsg(userId, chunk);
                         if (chunks.length > 1 && config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                     }
                 } else if (imageMedia.length > 0) {
                     // Image only: send with @ in groups
                     for (const m of imageMedia) {
                         const segments: any[] = [];
                         if (isGroup) segments.push({ type: "at", data: { qq: String(userId) } });
                         segments.push({ type: "image", data: { file: m.url } });
                         if (isGroup) await client.sendGroupMsg(groupId, segments);
                         else if (isGuild) await client.sendGuildChannelMsg(guildId, channelId, `[CQ:image,file=${m.url}]`);
                         else await client.sendPrivateMsg(userId, segments);
                         if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                     }
                 }

                 // Non-image files always sent separately
                 for (const m of fileMedia) {
                     const name = m.rawUrl.split('/').pop() || 'file';
                     const txtMsg = `[CQ:file,file=${m.url},name=${name}]`;
                     if (isGroup) await client.sendGroupMsg(groupId, txtMsg);
                     else if (isGuild) await client.sendGuildChannelMsg(guildId, channelId, `[文件] ${m.url}`);
                     else await client.sendPrivateMsg(userId, txtMsg);
                     if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                 }

                 // TTS support (text-only scenarios)
                 if (hasText && !isGuild && config.enableTTS && (payload.text?.length ?? 0) < 100 && imageMedia.length === 0) {
                     const tts = (payload.text ?? "").replace(/\[CQ:.*?\]/g, "").trim();
                     if (tts) {
                         if (isGroup) await client.sendGroupMsg(groupId, `[CQ:tts,text=${tts}]`);
                         else await client.sendPrivateMsg(userId, `[CQ:tts,text=${tts}]`);
                     }
                 }
            };

            const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({ deliver });

            let replyToBody = "";
            let replyToSender = "";
            if (replyMsgId && repliedMsg) {
                replyToBody = cleanCQCodes(typeof repliedMsg.message === 'string' ? repliedMsg.message : repliedMsg.raw_message || '');
                replyToSender = repliedMsg.sender?.nickname || repliedMsg.sender?.card || String(repliedMsg.sender?.user_id || '');
            }

            const replySuffix = replyToBody ? `\n\n[Replying to ${replyToSender || "unknown"}]\n${replyToBody}\n[/Replying]` : "";
            let bodyWithReply = cleanCQCodes(text) + replySuffix;
            let systemBlock = "";
            if (config.systemPrompt) systemBlock += `<system>${config.systemPrompt}</system>\n\n`;
            if (historyContext) systemBlock += `<history>\n${historyContext}\n</history>\n\n`;
            bodyWithReply = systemBlock + bodyWithReply;

            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
                Provider: "qq", Channel: "qq", From: fromId, To: "qq:bot", Body: bodyWithReply, RawBody: text,
                SenderId: String(userId), SenderName: event.sender?.nickname || "Unknown", ConversationLabel: conversationLabel,
                SessionKey: `qq:${fromId}`, AccountId: account.accountId, ChatType: isGroup ? "group" : isGuild ? "channel" : "direct", Timestamp: event.time * 1000,
                OriginatingChannel: "qq", OriginatingTo: fromId, CommandAuthorized: true,
                ...(extractImageUrls(event.message).length > 0 && { MediaUrls: extractImageUrls(event.message) }),
                ...(replyMsgId && { ReplyToId: replyMsgId, ReplyToBody: replyToBody, ReplyToSender: replyToSender }),
            });
            
            await runtime.channel.session.recordInboundSession({
                storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: "default" }),
                sessionKey: ctxPayload.SessionKey!, ctx: ctxPayload,
                updateLastRoute: { sessionKey: ctxPayload.SessionKey!, channel: "qq", to: fromId, accountId: account.accountId },
                onRecordError: (err) => console.error("QQ Session Error:", err)
            });

            try { await runtime.channel.reply.dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
            } catch (error) { if (config.enableErrorNotify) deliver({ text: "⚠️ 服务调用失败，请稍后重试。" }); }
        });

        client.connect();
        return () => { 
            clearInterval(cleanupInterval);
            client.disconnect(); 
            clients.delete(account.accountId); 
        };
    },
    logoutAccount: async ({ accountId, cfg }) => {
        return { loggedOut: true, cleared: true };
    }
  },
  outbound: {
    sendText: async ({ to, text, accountId, replyTo }) => {
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
        const chunks = splitMessage(text, 4000);
        for (let i = 0; i < chunks.length; i++) {
            let message: OneBotMessage | string = chunks[i];
            if (replyTo && i === 0) message = [ { type: "reply", data: { id: String(replyTo) } }, { type: "text", data: { text: chunks[i] } } ];
            
            if (to.startsWith("group:")) await client.sendGroupMsg(parseInt(to.replace("group:", ""), 10), message);
            else if (to.startsWith("guild:")) {
                const parts = to.split(":");
                if (parts.length >= 3) await client.sendGuildChannelMsg(parts[1], parts[2], message);
            }
            else await client.sendPrivateMsg(parseInt(to, 10), message);
            
            if (chunks.length > 1) await sleep(1000); 
        }
        return { channel: "qq", sent: true };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyTo }) => {
         const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
         if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
         
         // Send text part first if present
         if (text) {
             const message: OneBotMessage = [];
             if (replyTo) message.push({ type: "reply", data: { id: String(replyTo) } });
             message.push({ type: "text", data: { text } });
             if (to.startsWith("group:")) await client.sendGroupMsg(parseInt(to.replace("group:", ""), 10), message);
             else if (to.startsWith("guild:")) {
                 const parts = to.split(":");
                 if (parts.length >= 3) await client.sendGuildChannelMsg(parts[1], parts[2], message);
             }
             else await client.sendPrivateMsg(parseInt(to, 10), message);
             await sleep(500);
         }

         // Send media
         if (isImageFile(mediaUrl)) {
             const finalUrl = await resolveMediaUrl(mediaUrl);
             const message: OneBotMessage = [];
             if (!text && replyTo) message.push({ type: "reply", data: { id: String(replyTo) } });
             message.push({ type: "image", data: { file: finalUrl } });
             if (to.startsWith("group:")) await client.sendGroupMsg(parseInt(to.replace("group:", ""), 10), message);
             else if (to.startsWith("guild:")) {
                 const parts = to.split(":");
                 if (parts.length >= 3) await client.sendGuildChannelMsg(parts[1], parts[2], message);
             }
             else await client.sendPrivateMsg(parseInt(to, 10), message);
         } else {
             // Non-image file: use upload API
             const filePath = mediaUrl.startsWith("file://") ? fileURLToPath(mediaUrl) : mediaUrl;
             const fileName = path.basename(filePath);
             try {
                 if (to.startsWith("group:")) {
                     const groupId = parseInt(to.replace("group:", ""), 10);
                     await client.sendWithResponse("upload_group_file", {
                         group_id: groupId,
                         file: filePath,
                         name: fileName,
                     });
                 } else if (!to.startsWith("guild:")) {
                     const userId = parseInt(to, 10);
                     await client.sendWithResponse("upload_private_file", {
                         user_id: userId,
                         file: filePath,
                         name: fileName,
                     });
                 }
             } catch (err) {
                 console.warn(`[QQ] File upload failed, falling back to CQ code:`, err);
                 // Fallback: send as CQ code text
                 const finalUrl = await resolveMediaUrl(mediaUrl);
                 const msg = `[CQ:file,file=${finalUrl},name=${fileName}]`;
                 if (to.startsWith("group:")) await client.sendGroupMsg(parseInt(to.replace("group:", ""), 10), msg);
                 else await client.sendPrivateMsg(parseInt(to, 10), msg);
             }
         }
         
         return { channel: "qq", sent: true };
    },
    // @ts-ignore
    deleteMessage: async ({ messageId, accountId }) => {
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) return { channel: "qq", success: false, error: "Client not connected" };
        try { client.deleteMsg(messageId); return { channel: "qq", success: true }; }
        catch (err) { return { channel: "qq", success: false, error: String(err) }; }
    }
  },
  messaging: { 
      normalizeTarget,
      targetResolver: {
          looksLikeId: (id) => /^\d{5,12}$/.test(id) || /^group:/.test(id) || /^guild:/.test(id),
          hint: "QQ号, 群号 (group:123), 或频道 (guild:id:channel)",
      }
  },
  setup: { resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) }
};