# Linux 侧约束（M2）— dsh-wsl-desktop

本文记录发行版内部的 mount namespace 约束：机制、实测前提、以及**降权后保留的 sudo 授权这条围栏边界**（两条闭合路径与它们的实际可达性）。信任边界的结论摘要见根目录 [SECURITY.md](../SECURITY.md)；README 只保留结论那一句。

宿主的 `ctx.sandbox` 包不住 `wsl.exe`（子进程在 Linux 内核侧），所以约束发生在**发行版内部**：在 mount namespace 里把 `/` 改成只读，只留工作区与一个私有 `/tmp` 可写。

```
workspace-write:  bind <workspace>  →  tmpfs /tmp  →  remount,ro,bind /
read-only:        tmpfs /tmp        →  remount,ro,bind /
```

顺序是负载性的：**先绑可写路径，再 remount 根为只读**。反过来的话新 bind 会继承只读状态（实测工作区写入会失败）。

两个实测得出的前提：

- **必须 root。** WSL 内核拒绝在 user namespace 里做 bind mount：`unshare -Ur --mount` 能起，但 `mount --bind` 报 "wrong fs type"。所以用 `sudo -n unshare …`；没有免密 sudo 时受限模式**明确失败**（`SandboxUnavailableError`），而不是裸跑。
- **降权后保留的 sudo 授权是围栏的已知边界——两条闭合路径。** 会话用户保留着 runner 自己依赖的免密 sudo 授权——被约束的命令可以重新调用它（新开一个不带围栏脚本的 `sudo -n unshare --mount`，或在围栏内 `sudo -n mount -o remount,rw /`），从而绕过文件围栏。闭合路径（按优先级）：
  1. **专用 helper（推荐；一次安装，但每次升级插件后必须重装）**：
     ```bash
     # 在发行版内以 root 执行（路径按实际安装位置调整）
     install -m 0755 -o root -g root /mnt/c/Users/<you>/.dsh/profiles/desktop/plugins/dsh-wsl-desktop-*/lib/wsl/dsh-wsl-confine.sh /usr/local/sbin/dsh-wsl-confine
     echo "$USER ALL=(root) NOPASSWD: /usr/local/sbin/dsh-wsl-confine *" > /etc/sudoers.d/dsh-wsl-confine && chmod 0440 /etc/sudoers.d/dsh-wsl-confine
     ```
     helper 以 root 身份**总是先施加完整围栏**再降权执行命令——重新调用只会从已围栏的上下文再围栏一次，参数游戏（workspace='/'）被 `/ is not read-only` 后置条件击败。插件自动探测并优先使用 helper（sudoers 只授权这一个文件），但**只接受与插件要求完全一致的版本（当前 v1.2）**：v1.1 的豁免正则没有转义，工作区路径含元字符时会被误清扫成只读，含 `|` 的路径甚至会让 `/mnt/c` 成为豁免目标（受限会话里 Windows 文件系统保持可写）。因此**升级插件后必须重新执行上面的 install**；helper 版本不匹配时插件不会选它，而是回落到直接 sudo-unshare runner（其进程内构造器一直是正确的），不会静默沿用旧围栏。版本要求是**精确匹配**（不是“不低于”），所以将来提升 helper 版本时必须同时提升 `confinement.js` 里的 `HELPER_VERSION`——`verify-confinement.mjs` 有一条钉子把两者钉在一起，不一致会红。

     **helper 自己钉死 PATH，不依赖 sudoers。** 它以 root 身份按裸名调用十二个工具（getent/cut/sed/tr/mount/findmnt/grep/mountpoint/setpriv/env/bash/unshare）；`env_reset` 挡不住这件事——`secure_path` 只替换**继承来的** PATH，而以 `sudo PATH=… <helper>` 形式传入的赋值在策略允许时仍会到达 helper（debian/debian-dev/arch 实测；是否允许由 sudoers 的 `SETENV`/`ALL` 决定——本机是 `NOPASSWD: ALL`，sudo 对 ALL 隐含 SETENV），且 NOPASSWD 授权是参数通配的。身份闸门是最坏的一环：它信任经该 PATH 解析出的 getent/cut 输出，伪造的答案即可满足 `--uid 0 --gid 0`。因此 helper 把 PATH 钉为 `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` 并 `export`，而且这是它**执行的第一条语句**（早于参数解析与身份闸门）；发行版自己的 `secure_path` 请照原样保留——钉死是 helper 自己的保证，不是替代品。该钉子**没有回退**：十二个工具必须能在上述六个目录里解析到，解析不到就**失败关闭**（getent 缺失→调用者记录为空→闸门拒绝；cut 缺失→pipefail 下 127，围栏不会建立；`command -v` 预检→exit 97 + setup-failure 标记），绝不回退到调用者的 PATH——回退等于把这个洞原样放回来。

     **helper 在启动前就丢掉调用者给的 BASH_ENV，并且不导入环境里的函数。** bash 会在脚本第一行之前 source 调用者给的 `BASH_ENV` 文件——以 root 身份，早于本文件里的每一条控制（PATH 钉子在内，所以钉子关不掉它）。实测（bash 5.2.37）：`bash script`、`#!/bin/bash` shebang 经 exec、`bash -c` 都会 source，而 `bash -p script`、`#!/bin/bash -p` shebang、`bash -p -c` 都不会。由此有三处改动。shebang 是 `#!/bin/bash -p`。`-p` 不会把这个变量从环境里删掉，而每个后代都会继承它——降权后的 `bash -lc` 不是特权模式、确实会处理它（实测：以会话用户身份、在围栏内 source 了该文件）——所以 exec 尾巴用 `env -u BASH_ENV` 删除，删在唯一那条所有 root 阶段后代都挂在它下面的调用上。又因为 `-p` 是 shell 自身的属性，围栏体这个独立的 `bash -c` 仍会导入调用者导出的函数：一组配合好的 `mount`/`findmnt`/`mountpoint` 覆盖会让清扫报告“系统已受限”而 `/mnt/c` 保持可写（实测：静默绕过围栏；只覆盖 `mount()` 时只是碰巧在后置条件上失败关闭），因此围栏体也用 `-p` 启动，使这类覆盖彻底失效。`-p` 同时关掉了绕过 PATH 钉子的第二条伪造路径（实测：伪造的 `getent()` 函数让身份闸门接受 `--uid 0 --gid 0`，命令以 uid 0 跑在围栏里；加上 `-p` 后闸门拒绝，exit 2）。严重性：这是围栏之前、第一行之前的无约束 root 代码执行，超出 PATH 钉子关掉的“围栏内 root 访问”（围栏内的 root 也不是只读者，见身份闸门那段）——可达性由 sudoers 决定：**窄**规则并**不**隐含 SETENV，而导出的 `BASH_ENV` 会被 sudo 的 env_reset 剥掉（实测），所以这条路需要命令行赋值形式，而 SETENV 允许它、`ALL` 匹配隐含它；helper 侧的修复因此是无条件的，不依赖部署的 sudoers。`HELPER_VERSION` 保持 v1.2，所以**没重装的旧 helper 仍会被探测选中**——升级插件后必须重装，这次尤其。

     **身份闸门失败关闭，但它只在没有 SETENV 的部署里成立。** 闸门用 SUDO_USER 判断调用者；空值或未设**曾经意味着跳过检查**，而这个变量是调用者可设的：实测 `sudo -n SUDO_USER= <helper> --uid 0 --gid 0 --home /root --cwd / -- '…'` 与 `sudo -n env -u SUDO_USER` 都让命令以 uid 0 跑在围栏里、`/etc/shadow` 可读。现在空值/未设一律**拒绝**（exit 2；root 自己直接调用请显式传 `SUDO_USER=root`）。但闸门挡不住**伪造**：`sudo SUDO_USER=root <helper> --uid 0 --gid 0 …` 仍被接受——闸门只有这一个身份来源，`SUDO_UID` 走同一条路同样可伪造，交叉校验买不到东西。因此闸门**只在 sudoers 不授予 SETENV 的部署里**才是边界（没有 `ALL` 匹配、也没有命令行赋值形式）；授予 SETENV 时它只挡无意误用、不挡伪造，围栏会按**伪造的 uid** 降权——那是 root **写**，不是读原语：只读状态是私有 namespace 里的 per-mount bind remount，伪造的 uid 0 可以 `mount -o remount,rw /` 与 `mount -o remount,rw /mnt/c`（实测两者都成功，且两个文件系统上都有真实写入落地：root-only 路径、以及 /mnt/c 下新建的文件），从而写发行版文件系统与 Windows 文件系统；仍然成立的只有 namespace 与 NO_NEW_PRIVS，文件围栏不在了。
  2. **NO_NEW_PRIVS（自动，无 helper 时的缓解）**：降权时运行时探测 `setpriv --no-new-privs` 支持（debian 系现代 setpriv 满足，实测 `noNewPrivs: true` 已激活）——围栏内 setuid 提权响亮失败。探测是**三态**的：`false`（该 setpriv 不支持）→ 拒绝，给出 `NO_NEW_PRIVS_UNSUPPORTED`；未测到答案（探针没跑成）→ 同样拒绝，给出 `NO_NEW_PRIVS_UNMEASURED`；只有测到 `true` 才以 `--no-new-privs` 降权。所以**不支持该标志的发行版根本不会运行受限命令**，而且装 helper 不是绕过：helper 的降权用的是同一个标志，同样失败关闭（setpriv 对未知选项 exit 1，实测）——修法是升级发行版的 util-linux。`enforcement: 'partial'` 与这一条无关：它对**每一次**受限运行都成立，描述的是 mount namespace 约束不到的部分（/dev、/proc、/sys 与 interop）加上上面那条保留 sudo 的边界。
- **findmnt 的 `\xNN` 转义已解码。** `findmnt -r` 会把 TARGET 里的空格/制表/换行/反斜杠编码为 `\x20` 等——修复前清扫按字面转义名 remount（ENOENT 被 `|| true` 吞掉）且后置条件测的是假名，含空格的挂载点在只读模式下保持可写而退出码 97 不触发。现在两处管道都先解码再匹配，并有真实含空格 bind 目标的只读断言回归（verify-confinement）。
- **进 namespace 后必须降回原用户。** 经 `sudo` 进入后 euid 是 root，直接用会让工作区里出现 root 属主文件；用 `setpriv --reuid --regid --init-groups` 降回会话用户（有断言覆盖属主）。
- **所有输出被解析的探针一律非登录。** `resolveIdentity` / `detectRunner` / `detectNoNewPrivs` / `listLinuxDir` / `checkLinuxPath` / `resolveDistroHome` / `resolveLoginShell` / `resolveExecutable` / pty 的 python3 探测全部 `loginShell: false`——登录 shell 的 rc 会先于探针命令输出，位置性解析就会把 profile 打印的内容当作 uid/gid/home（模型可写 dotfiles 时等于把 setpriv 的 uid 交给攻击者）。`resolveIdentity` 额外用 `__DSH_IDENTITY__` 哨兵行界定 + 恰好四行校验，解析失败抛**携带探针实际输出**的错误（不再静默 null）。探针超时 60s + 超时后一次透明重试：桌面重启后的首个 wsl.exe 冷启动可以超过短上限。
- **wsl.exe 的选项值在 spawn 前过语法校验。** `runWslShell` / `buildWslExecArgv` 顶部对 distro（`DISTRO_NAME`）与 username（`LINUX_USER`）拒绝分隔符字符——exec 路径的安全性不依赖 wsl.exe 外部未文档化的分词规则；checkPath 也在任何 wsl.exe 副作用之前先做 UNC 校验（回归钉在 verify-world）。

