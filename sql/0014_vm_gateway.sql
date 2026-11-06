-- 终端网关：群里的虚拟机要能被真人当 iTerm 那样连上去，靠的是 VM 上一个把 PTY 暴露成
-- WebSocket 的网关（ttyd 一类），浏览器直接连它，不是 WorkStream 去登 SSH。
--
-- 为什么是一列 URL 而不是 host/port 拼出来：网关跑在哪个端口、挂在哪个路径前缀、用 ws 还是 wss
-- 都是 VM 侧的部署事实，和 SSH 那台机器的 host:22 没有必然关系；拼出来就等于替用户猜一个端口，
-- 猜错了界面只会说「连不上」。旧行没有这一列，读出来按「没有网关、终端不可用」处理。
--
-- 为什么明文存：这一列只有地址，没有凭据。ttyd 的 Basic Auth 在网关侧配置，WorkStream 的 VM 口令
-- 仍然只在 secret_cipher 里密封、从不下发浏览器——浏览器连网关用的是网关自己的认证，不是那份口令。
ALTER TABLE app.vms ADD COLUMN gateway_url text;
