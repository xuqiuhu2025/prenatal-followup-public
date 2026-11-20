# Git 使用与源码备份

公开仓库为 https://github.com/xuqiuhu2025/prenatal-followup-public 。这是清理后的独立源码历史，不应把含真实部署参数的旧仓库分支合并或推送到这里。

获取源码：

    git clone https://github.com/xuqiuhu2025/prenatal-followup-public.git
    cd prenatal-followup-public

修改后先用 git status 和 git diff 检查文件，再仅暂存准备公开的路径，检查 git diff --cached 后提交与推送。每次新增配置都应使用占位模板，并把真实内容留在忽略的本地 .env。

根目录 .gitignore 排除数据库、凭据、私钥、分机配置、录音和本地备份。已经提交的文件不受后来新增的忽略规则保护；不要提交患者表格、日志或运行目录。

从 Git 克隆只能恢复源码，不能恢复患者数据库、真实模型密钥、证书、分机账号或通话数据。这些需要各自的受限备份。
