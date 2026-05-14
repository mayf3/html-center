# HTML Center

HTML Center 是一个本机常驻的小服务，用来集中收纳自己或 agent 生成的 HTML 内容。

典型用途：

- design review 产出的单文件 HTML 报告
- 带 `assets/`、多层目录、多个页面的静态站点包
- 临时预览但不想为每个 HTML 单独起服务的页面

默认只监听本机 `127.0.0.1:4177`，运行数据保存在 `data/`，不会提交到 git。

## 启动

```bash
npm start
```

打开：

```text
http://127.0.0.1:4177
```

可选环境变量：

```bash
PORT=4177
HOST=127.0.0.1
HTML_CENTER_DATA_DIR=/path/to/data
HTML_CENTER_MAX_MB=250
```

## 上传

上传单个 HTML 文件：

```bash
npm run upload -- ./design-review.html --title "Design review" --category design-review
```

上传一个带静态资源的目录：

```bash
npm run upload -- ./docs --title "Gateway review" --category design-review --entry index.html
```

上传脚本会优先读取 `HTML_CENTER_URL`，没有设置时使用 `http://127.0.0.1:4177`。

## API

`POST /api/sites`

```json
{
  "title": "Design review",
  "category": "design-review",
  "description": "Optional notes",
  "source": "/path/to/original/output",
  "entry": "index.html",
  "tags": ["review"],
  "files": [
    {
      "path": "index.html",
      "encoding": "base64",
      "content": "PGh0bWw+PC9odG1sPg=="
    },
    {
      "path": "assets/app.css",
      "encoding": "base64",
      "content": "Ym9keSB7IG1hcmdpbjogMDsgfQ=="
    }
  ]
}
```

返回：

```json
{
  "id": "20260513-225500-design-review-a1b2c3d4",
  "url": "http://127.0.0.1:4177/open/...",
  "entryUrl": "http://127.0.0.1:4177/view/.../index.html",
  "site": {}
}
```

常用接口：

- `GET /`：首页索引
- `GET /api/health`：健康检查
- `GET /api/sites`：全部记录
- `GET /open/:id`：打开上传包入口页
- `GET /view/:id/path/to/file`：访问上传包里的静态文件

## 和 skill 集成

仓库里带了一份 `web-design-review` skill：

```text
skills/web-design-review
```

你可以在仓库里继续改这份 skill，再同步到自己的 Codex skills 目录。当前本机 `~/.codex/skills/web-design-review` 也已经带了同样的发布脚本。

```bash
python ~/.codex/skills/web-design-review/scripts/publish_html_report.py ./design-review.html \
  --title "Design review" \
  --category design-review
```

上传目录包：

```bash
python ~/.codex/skills/web-design-review/scripts/publish_html_report.py ./docs \
  --title "System design review" \
  --category architecture-review \
  --entry index.html
```

## 安全边界

这个项目按“本机个人工具”设计。

- 不要把服务直接暴露到公网。
- 上传的 HTML 会按原样在浏览器里执行 CSS/JS，只上传可信内容。
- 如果把 `HOST` 改成 `0.0.0.0`，同一网络内的人也可能上传或打开内容。
- `data/` 是运行数据目录，默认被 `.gitignore` 排除。

## 检查

```bash
npm run check
```
