# 自动挂载 Grok 凭据

**密匙不要出本机。** 不要 `cat` / `grep` / `echo` `~/.grok/auth.json`、`~/.dsh/.credentials.yaml` 或 `GROK_SESSION_TOKEN` 的值；不要把 JWT 或 token 贴进聊天、issue、日志。检查只报 `present` / `missing` / `yes` / `no`。

`dsh-llm-grok` **不会**读 `~/.grok/auth.json`，也不会自己 refresh。它每次请求只解析 DSH 凭据引用 `GROK_SESSION_TOKEN`。Grok CLI 的 access token 大约 **6 小时**过期；CLI 自己启动时会静默续期 `auth.json`，但没人把新 token 写回 DSH 就会 401。

本仓库提供方案 A：用系统定时任务，把 CLI 刚续好的 token 同步进 `$DSH_HOME/.credentials.yaml`。DSH 的 credentials 服务用 chokidar 监视该文件，**外部写入会热发布，不必重启 DSH**。

```
grok CLI 每次启动 → 静默续期 ~/.grok/auth.json（refresh_token 必须还在）
       ↓（launchd / cron 每 5 分钟）
scripts/sync-grok-credential.py → 读到新 token → 不同则原子写 ~/.dsh/.credentials.yaml（0600）
       ↓（DSH chokidar 热加载）
credentials.resolve('GROK_SESSION_TOKEN') → 下一发请求用新 token
```

方案 B（插件内用 `refresh_token` 惰性刷新）尚未实现。

## 1. 一次性写入（最小可用）

1. 本机已 `grok login`，且 HTTP 代理能访问订阅端点（默认 Clash `http://127.0.0.1:7890`）。
2. 从仓库根执行一次同步：

   ```bash
   python3 scripts/sync-grok-credential.py
   ```

   已同步时脚本 **exit 0 且无输出**（幂等 no-op）。写出时会打印 `synced GROK_SESSION_TOKEN (N chars)`。
3. 当前 DSH 凭据文档是 version-1，应类似：

   ```yaml
   version: 1
   refs:
     GROK_SESSION_TOKEN: <token>
   ```

   **不要**再往文件顶层写扁平的 `GROK_SESSION_TOKEN:`。现行 DSH 会把未知顶层键当成损坏文档（`unknown top-level key`），`dsh web` 可能起不来。扁平旧文档只在**下次启动**时会被识别并迁到 `refs:`；热重载不会迁移。
4. 未配置时请求失败：`dsh-llm-grok: missing credential GROK_SESSION_TOKEN`。

也可以启动 DSH **之前** `export GROK_SESSION_TOKEN=...`。注意下一节的优先级。

## 2. 优先级：环境变量会挡住文件

DSH 本地凭据层从高到低：

| 层 | 来源 | 能否被文件同步改掉 |
|---|---|---|
| 进程环境 | 启动 `dsh` 时继承的 `GROK_SESSION_TOKEN` | **不能**。`describe()` 报 `source: env, writable: false` |
| `$DSH_HOME/.credentials.yaml` | 本脚本写入的 `refs.GROK_SESSION_TOKEN` | 能，热加载 |
| 项目 / 用户 `.env` | 更低后备 | 文件层有值时用不到 |

现场常见坑：shell、launchd、systemd、IDE 或 CI 把 `GROK_SESSION_TOKEN` 留在 **dsh 进程的环境里**。脚本照样更新 yaml，但 `resolve()` 一直返回那份旧 env，表现为「同步成功了还是 401」。

处理（只问有没有这个变量，**不要** `echo` / `env | grep` 它的值）：

```bash
# 有遮挡 → 打印 yes；没有 → 打印 no。不会打出 token。
python3 -c "import os; print('yes' if os.environ.get('GROK_SESSION_TOKEN') else 'no')"

# 清掉后再启 DSH
unset GROK_SESSION_TOKEN
# 然后用你平时的方式启动 dsh web，不要带着该变量
```

同步脚本改的是文件，**不会** `unset` 你的环境变量。

## 3. macOS：launchd 每 5 分钟同步

仓库脚本会按当前用户生成 Label（`com.<user>.sync-grok-credential`），避免多用户机器抢同一个 job 名。

```bash
chmod +x scripts/sync-grok-credential.py scripts/install-launchd.sh
./scripts/install-launchd.sh
./scripts/install-launchd.sh status
```

安装器会：

1. 写出 `launchd/com.<user>.sync-grok-credential.plist`（路径指向本仓库的 python 脚本，**移动仓库后要重装**）。
2. 尽量 `cp` 到 `~/Library/LaunchAgents/`（重启后 launchd 认这个位置）。
3. `launchctl bootstrap gui/$(id -u) <plist>`。
4. 立刻跑一次同步。

查看 / 卸载：

```bash
./scripts/install-launchd.sh status
./scripts/install-launchd.sh uninstall
```

日志：`/tmp/sync-grok-credential.log`。空文件 + `last exit code = 0` = 已同步、幂等 no-op。

`launchctl print` 里 **`state = not running` 是正常的**：`RunAtLoad` 把脚本拉起来后它秒退，launchd 在等下一个 300 秒周期。不要据此判断 job 挂了。

### `~/Library/LaunchAgents` 写不进去

部分环境（沙箱、某些 agent 会话、目录被 TCC / 策略拦住）能读 `~/Library/LaunchAgents`，但 `cp` 失败。安装器会退回到 **从仓库路径 bootstrap**。这能立刻 work，但 **重启机器后 launchd 不一定还记得非标准位置的 plist**。

稳妥做法：在能写该目录的终端里手动放一次：

```bash
cp launchd/com.$(id -un).sync-grok-credential.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/com.$(id -un).sync-grok-credential 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.$(id -un).sync-grok-credential.plist
```

用户名含非法 Label 字符时，安装器会把非 `[A-Za-z0-9._-]` 换成 `_`。以 `./scripts/install-launchd.sh status` 打印的 `label:` 为准。

不要同时装两套（例如旧的 `com.clark.sync-grok-credential` 和新的同功能 job）。`uninstall` 只卸当前 Label。

## 4. Linux：cron

```bash
crontab -e
# 每 5 分钟；把路径换成你的克隆位置
*/5 * * * * /usr/bin/python3 /path/to/dsh-llm-grok/scripts/sync-grok-credential.py >> /tmp/sync-grok-credential.log 2>&1
```

systemd user timer 同样可以，命令就是这一行 python。

## 5. 验证

```bash
# 1. grok CLI 本身能说话（会顺带续期 auth.json）
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890
grok -p "Reply with exactly: ok" --output-format plain

# 2. 同步进 DSH 文件（成功只打印 synced … (N chars)，不打印 token）
python3 scripts/sync-grok-credential.py

# 3. 只确认 yaml 里有这个 key 名，不要 cat / grep 出值，也不要贴到聊天里
python3 -c "
import os, re
p = os.path.expanduser('~/.dsh/.credentials.yaml')
text = open(p, encoding='utf-8').read()
print('present' if re.search(r'GROK_SESSION_TOKEN:', text) else 'missing')
"

# 4. 若 DSH 正在跑：下一发 Grok 请求应不再 401，无需重启
```

手动强制 CLI 刷新（token 还没过期时 CLI 会直接复用）见仓库外的操作笔记；常规路径是「用一下 grok CLI，等下一轮同步」。

## 6. 边界与不要做的事

1. **6 小时硬边界仍在。** 若 6 小时内 grok CLI 完全没跑过，`auth.json` 里的 token 也会过期，同步进 DSH 的同样是过期 token，请求仍 401。launchd 只搬 token，不代替 CLI 去 refresh。保持 CLI 偶发使用，或另做方案 B。
2. **不要 `grok logout`。** 会清掉 `refresh_token`，之后只能交互式浏览器登录。清空 `key`、保留 `refresh_token` 才是强制续期姿势。
3. **`grok login` 不能当非交互刷新。** 已登录时它也不会替你转一圈。
4. **代理必须开。** Clash 不在 7890 时，CLI 和订阅端点都会失败；那是网络问题，不是同步脚本问题。
5. 同步脚本兼容 macOS 系统 python3 3.9（不用 `str | None`）。解析失败只报 stderr，**不改**现有 DSH 凭据。
6. version-1 文档写入 `refs.GROK_SESSION_TOKEN`（两空格缩进），并删掉顶层多余的扁平键；尚未升级的扁平文档仍写顶层 `GROK_SESSION_TOKEN:`。
7. **不要把 token 打到终端或聊天里。** 不要 `cat` / `grep` 凭据文件、不要 `echo $GROK_SESSION_TOKEN`、不要把 JWT 片段贴进 issue。检查只报 present / missing / yes / no。

## 7. 故障表

| 现象 | 先查 |
|---|---|
| `missing credential GROK_SESSION_TOKEN` | yaml 里没有该 key；或 DSH 看的不是 `~/.dsh` |
| 同步成功仍 401 | env 遮挡（§2）；或 6h 过期且 CLI 没续上 |
| `unknown top-level key` / DSH 起不来 | 顶层扁平 `GROK_SESSION_TOKEN` 写进了 version-1 文档 |
| launchd `state = not running` | 正常，见 §3 |
| 重启后 job 消失 | plist 只从仓库路径加载，没进 `~/Library/LaunchAgents` |
| 日志有 `cannot read ~/.grok/auth.json` | 还没 `grok login`，或路径/权限不对 |
