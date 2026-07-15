import { createHash, timingSafeEqual } from "node:crypto";

export function wechatSignature(token, timestamp, nonce) {
  return createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
}

export function verifyWechatSignature(token, query) {
  const expected = Buffer.from(wechatSignature(token, query.timestamp || "", query.nonce || ""));
  const supplied = Buffer.from(String(query.signature || ""));
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function parseWechatXml(xml) {
  const values = {};
  const pattern = /<([A-Za-z][A-Za-z0-9]*)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>|<([A-Za-z][A-Za-z0-9]*)>([^<]*)<\/\3>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const name = match[1] || match[3];
    values[name] = (match[2] ?? match[4] ?? "").trim();
  }
  return values;
}

export function routeWechatText(text, config) {
  const clean = String(text || "").trim();
  if (!clean) throw new Error("没有识别到任务内容");
  let projectId = config.wechat.defaultProjectId;
  let prompt = clean;
  const prefix = config.wechat.routePrefix;
  if (prefix && clean.startsWith(prefix)) {
    const separator = clean.search(/\s/);
    const alias = clean.slice(prefix.length, separator < 0 ? undefined : separator);
    if (alias) {
      projectId = alias;
      prompt = separator < 0 ? "" : clean.slice(separator).trim();
    }
  }
  const project = config.projects.find((item) => item.id === projectId);
  if (!project) throw new Error(`未知项目：${projectId}`);
  if (!prompt) throw new Error("项目名后面还需要任务描述");
  return { project, prompt };
}

export function wechatTextReply(incoming, content) {
  const cdata = (value) => String(value).replaceAll("]]>", "]]]]><![CDATA[>");
  return `<xml><ToUserName><![CDATA[${cdata(incoming.FromUserName || "")}]]></ToUserName><FromUserName><![CDATA[${cdata(incoming.ToUserName || "")}]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${cdata(content)}]]></Content></xml>`;
}
