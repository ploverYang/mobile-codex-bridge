import assert from "node:assert/strict";
import test from "node:test";
import { parseWechatXml, routeWechatText, verifyWechatSignature, wechatSignature } from "../bridge/wechat.mjs";

const config = {
  projects: [
    { id: "alpha", name: "Alpha", path: "C:/alpha" },
    { id: "beta", name: "Beta", path: "C:/beta" },
  ],
  wechat: { defaultProjectId: "alpha", routePrefix: "#" },
};

test("WeChat signature and XML parsing", () => {
  const signature = wechatSignature("token", "123", "456");
  assert.equal(verifyWechatSignature("token", { timestamp: "123", nonce: "456", signature }), true);
  assert.equal(verifyWechatSignature("token", { timestamp: "123", nonce: "456", signature: "bad" }), false);
  const parsed = parseWechatXml("<xml><ToUserName><![CDATA[to]]></ToUserName><MsgType><![CDATA[voice]]></MsgType><Recognition><![CDATA[修复测试失败。]]></Recognition><CreateTime>123</CreateTime></xml>");
  assert.deepEqual(parsed, { ToUserName: "to", MsgType: "voice", Recognition: "修复测试失败。", CreateTime: "123" });
});
test("WeChat project routing supports an explicit prefix and default", () => {
  assert.equal(routeWechatText("检查构建", config).project.id, "alpha");
  const routed = routeWechatText("#beta 修复测试", config);
  assert.equal(routed.project.id, "beta");
  assert.equal(routed.prompt, "修复测试");
  assert.throws(() => routeWechatText("#missing do it", config), /未知项目/);
});
