# 开发与发布

## 验证

```powershell
npm test
npm run self-test
npm run doctor
```

代码更新还必须完成：

1. Node 语法检查和相关测试。
2. 插件 manifest 校验。
3. `npm run stop` 后执行 `npm run daemon:start`。
4. `npm run status` 确认服务在线、Codex 已连接且版本正确。
5. `/api/health` 返回相同版本和 `codexReady=true`。

## 版本规则

- 每次代码更新使用未用过的新基础版本。
- 向后兼容功能、界面、修复和运维改进升级 MINOR。
- 不兼容的 API、配置、存储、认证或 Codex 协议修改升级 MAJOR。
- 同步更新 `package.json`、`.codex-plugin/plugin.json` 基础版本和 `public/service-worker.js` 缓存名。
- 设置基础版本后运行插件 cachebuster，使 manifest 版本包含新的 `+codex.<timestamp>`。

详细的代理执行约束见仓库根目录 `AGENTS.md`。

## 隐私测试边界

- 不把 `config.local.json`、`data/`、日志、配对码、令牌、Cookie、私有 tailnet 地址或真实任务历史加入测试夹具。
- 使用临时目录和虚构项目 id。
- 真实闭环验证使用无副作用提示词。
