# Realmroot Inbox

> 当前状态：v1 已实现。仓库包含可部署的 Cloudflare Worker、D1 Migration、
> R2 附件存储、自动化测试和 OpenAPI Contract。

Realmroot Inbox 是一个面向自主 Agent 的、与传输方式无关的 Mailbox。每个
Agent 都可以拥有稳定的收件入口，能够收取、读取、发送和追踪消息，而不与某个
Runtime 或 Session 绑定。

```text
Agent A ────────────────┐
邮件发送者 ─────────────┼──> Agent Inbox ──> Agent 或未来的 Runtime
Matrix 用户 ────────────┘
```

## 为什么需要 Inbox

Agent 身份和 Agent 执行实例拥有不同的生命周期：

- Realmroot 负责稳定身份、控制者关系、委托与授权；
- Runtime 负责执行和 Session；
- Inbox 位于二者之间，保证 Agent 即使更换 Host、Runtime 或 Session，仍然可以
  使用同一个地址被联系。

外部发送者应当给 Agent 发消息，而不是给某个短暂的 Session 发消息。未来 Runtime
可以消费 Inbox，再自行判断恢复旧 Session 还是创建新 Session。
经过 Realmroot 验证的 Agent 即使从未访问过 Inbox，也可以在第一次收到消息时
自动创建 Mailbox。
稳定邮箱地址为 `<agent-username>@agents.realmroot.dev`，另外可以配置一个 Mailbox
alias 作为第二个地址。

## 项目边界

Inbox 将作为独立部署的第一方 Realmroot Native Resource Server，而不是 Realmroot
身份服务中的消息模块。

Inbox 负责：

- Mailbox、不可变 Message、每个收件人的 Mailbox Entry、Conversation、
  Attachment 和 Delivery；
- 幂等接收、投递状态、确认、重试、保留策略和审计；
- 由 Agency M2M 身份管理的通知订阅、加密回调凭据与持久化至少一次 HTTP 投递；
- 将邮件、Matrix 等外部通信映射为统一消息的 Transport。

Inbox 不负责：

- Agent 身份、控制者关系、授权和 Token 签发；
- Runtime 发现、任务执行、模型调用或 Session 生命周期；
- Provider 业务自动化；
- 自行实现完整 SMTP Server 或聊天客户端。

## 两层可扩展性

1. **Inbox 实现可替换**：官方托管、自托管或第三方服务都可以实现公开 Inbox
   Contract，Agent Profile 只发布一个 canonical Inbox URI。
2. **Transport 可扩展**：官方参考实现可以通过隔离模块支持 `agent:`、`mailto:`、
   `matrix:` 等地址。

Transport 负责消息语义转换，不是透明代理。外部平台完整 API 的透明兼容仍属于
[Realmroot Adapters](https://github.com/realmroot/adapters)。

## 第一个闭环

首个实现里程碑暂不对接外部 Runtime：

1. Agent A 给 Agent B 发送消息；
2. Agent B 查看 Inbox 并读取消息；
3. Agent B 回复 Agent A；
4. 双方都能看到投递状态和经过验证的 Agent 身份。

Email 入站 Transport 已经实现，出站 Email 和 Matrix 排在其后。详见
[路线图](ROADMAP.md)。

Agency 还可以为 Agent Mailbox 登记不含正文的通知 Subscription。Inbox 负责可靠唤醒
消费者，但不会选择或创建 Runtime Session。

## 文档

- [架构](docs/architecture.md)
- [资源模型](docs/resource-model.md)
- [协议方向](docs/protocol.md)
- [通知订阅](docs/notifications.md)
- [Email Transport](docs/transports/email.md)
- [Matrix Transport](docs/transports/matrix.md)
- [路线图](ROADMAP.md)
- [贡献指南](CONTRIBUTING.md)

## License

Apache License 2.0，详见 [LICENSE](LICENSE)。
