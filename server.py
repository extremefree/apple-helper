"""实时数据推送服务器

Flask + Flask-SocketIO(threading 模式)。
- 横轴为整分钟刻度(10:00, 10:01, ...), 每分钟一个数据点
- 每个分钟的数据只生成一次, 永不覆盖 (只初始化一次)
- 历史持久化到 data.json, 服务器重启不会重新随机已有分钟
- 客户端连接收到全量 snapshot, 之后每分钟收到新 point
- 同时托管 camera.html 与静态文件
- 端口 5000 (避开同目录 server.c 的 8080)

运行: pip install -r requirements.txt && python server.py
访问: http://localhost:5000/
"""
import os
import json
import random
import time
import urllib.request
import urllib.error

from flask import Flask, send_file
from flask_socketio import SocketIO

# ---------- 配置 ----------
HOST = "0.0.0.0"
PORT = 5000
SAMPLE_INTERVAL = 1.0          # 检查"是否进入新分钟"的间隔(秒)
NUM_CHARTS = 3                 # 图表数量
NUM_LIST = 6                   # 清单项数 (p1~p6)
LIST_MIN = 0                   # 清单随机整数下限
LIST_MAX = 100                 # 清单随机整数上限
DISEASE_NAMES = ["白粉病", "黑星病", "锈病", "炭疽病", "轮纹病", "叶斑病", "灰霉病"]

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(HERE, "data.json")

app = Flask(__name__, static_folder=HERE, static_url_path="")
app.config["SECRET_KEY"] = "dev-secret"
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*")

# 数据存储: minute_ts(int, 该分钟0秒) -> [ {"line":,"bar":} x NUM_CHARTS ]
# 每个分钟只写入一次, 之后永不覆盖
data_store = {}

# 清单数据: NUM_LIST 个随机整数, 每分钟更新一次, 不持久化历史
#   index 0-4: 土壤湿度/水箱水位/结果数量/今日浇水量/本次浇水量
#   index 5: 病害总处数 (由病害详情汇总)
last_list = [0] * NUM_LIST

# 病害详情: [{name, count}, ...] 每分钟刷新, 不持久化
last_disease = []


def gen_disease():
    """随机生成 0-4 种病害及其处数"""
    n = random.randint(0, 4)
    if n == 0:
        return []
    chosen = random.sample(DISEASE_NAMES, n)
    return [{"name": name, "count": random.randint(1, 9)} for name in chosen]


def load_store():
    """从 data.json 读取历史"""
    global data_store
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                data_store = {int(k): v for k, v in json.load(f).items()}
            print(f"[store] loaded {len(data_store)} minutes", flush=True)
        except Exception as e:
            print(f"[store] load failed: {e}", flush=True)


def save_store():
    """原子写 data.json"""
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({str(k): v for k, v in data_store.items()}, f)
    os.replace(tmp, DATA_FILE)


def current_minute():
    """当前分钟的 0 秒时间戳(秒)"""
    return int(time.time() // 60 * 60)


@app.route("/")
def index():
    return send_file(os.path.join(HERE, "camera.html"))


@socketio.on("connect")
def on_connect():
    # 推送全量历史(按时间升序)
    arr = [{"t": k, "charts": v} for k, v in sorted(data_store.items())]
    socketio.emit("snapshot", arr)
    socketio.emit("list", last_list)        # 同时推送当前清单
    socketio.emit("disease", last_disease)  # 推送病害详情
    # 后台用 ollama 生成建议/价值 (慢, 不阻塞连接响应)
    socketio.start_background_task(emit_advice)
    socketio.start_background_task(emit_value)
    print(f"[socket] connect -> snapshot {len(arr)} minutes, list={last_list}", flush=True)


@socketio.on("disconnect")
def on_disconnect():
    print("[socket] client disconnected", flush=True)


@socketio.on("button")
def on_button(data):
    """前端按钮点击上报"""
    print(f"[button] {data}", flush=True)


@socketio.on("direction")
def on_direction(data):
    """方向控制器上报"""
    print(f"[direction] {data}", flush=True)


@socketio.on("pitch")
def on_pitch(data):
    """俯仰角滚轮上报"""
    print(f"[pitch] {data}", flush=True)


@socketio.on("disease_request")
def on_disease_request(data=None):
    """前端请求重新检测病害: 重新生成病害并推送"""
    global last_disease, last_list
    last_disease = gen_disease()
    last_list[5] = sum(d["count"] for d in last_disease)
    socketio.emit("disease", last_disease)
    socketio.emit("list", last_list)
    print(f"[disease_request] regenerated: {last_disease}", flush=True)


# ---------- AI 对话 / 农事建议 / 价值分析 ----------
# ollama 本地模型 (gemma3:12b), 失败时回退到预设关键词回复
OLLAMA_URL = "http://localhost:11434/api/chat"
OLLAMA_MODEL = "phi3:mini"


def data_context():
    """生成当前实时数据描述, 作为 AI 上下文"""
    names = ["土壤湿度(%)", "水箱水位(%)", "结果数量(个)", "今日浇水量(mL)", "本次浇水量(mL)", "病害数量(处)"]
    items = [f"{names[i]}={last_list[i]}" for i in range(min(len(last_list), len(names)))]
    disease = "、".join(f"{d['name']}{d['count']}处" for d in last_disease) or "无"
    return (
        f"你是苹果果园智能管家。当前实时监测数据：{', '.join(items)}；"
        f"检测到的病害：{disease}。请基于这些真实数据回答，简洁实用。"
    )


def ollama_chat(q, system=None):
    """调用本地 ollama 模型, 可带 system 上下文。失败返回 None"""
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": q})
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("message", {}).get("content", "").strip() or None
    except Exception as e:
        print(f"[ollama] failed: {e}", flush=True)
        return None


def emit_advice():
    """用 ollama 生成今日农事建议并推送 (失败用兜底库)"""
    reply = ollama_chat(
        "请基于当前果园数据给出一条简短的今日农事建议(30字以内)。",
        system=data_context(),
    )
    socketio.emit("advice", reply or random.choice(ADVICE_POOL))


def emit_value():
    """用 ollama 生成价值分析并推送 (失败用兜底库)"""
    reply = ollama_chat(
        "请基于当前果园数据(结果数量、病害等)给出一条简短的苹果价值/经济分析(30字以内)。",
        system=data_context(),
    )
    socketio.emit("value", reply or random.choice(VALUE_POOL))


ADVICE_POOL = [
    "今日土壤湿度适宜，可暂缓浇水。",
    "近期多雨，注意排水防涝，预防灰霉病。",
    "果实膨大期，建议追施钾肥提升糖度。",
    "午后高温，建议开启遮阳网防止日灼。",
    "监测到病害风险，建议喷施保护性杀菌剂。",
]
VALUE_POOL = [
    "当前苹果规格整齐，预计商品果率 85%+，议价能力较强。",
    "糖度检测 14.2°Brix，达优质标准，适合高端渠道。",
    "本周产区均价 6.8 元/kg，建议分批采摘错峰销售。",
    "果径 80mm 以上占比 60%，符合一级果标准。",
]


def gen_reply(q):
    """简单关键词回复 (后续可接 LLM)"""
    q = q or ""
    if "浇水" in q:
        return "根据土壤湿度监测：当前>60% 可暂缓浇水；低于 40% 建议早晚各浇一次。"
    if "病害" in q or "白粉" in q or "锈病" in q or "灰霉" in q:
        return "常见病害建议：白粉病用醚菌酯，锈病用三唑酮，灰霉病用嘧霉胺，注意通风降湿。"
    if "价值" in q or "价格" in q:
        return "当前苹果达一级果标准，预估产值约 8-12 万元/亩，随行情波动。"
    if "天气" in q:
        return "未来三天以晴为主，午后注意高温日灼，建议开启遮阳网。"
    return "已收到您的问题，建议结合实时监测数据综合判断。"


@socketio.on("chat")
def on_chat(msg):
    """AI 对话: ollama + 实时数据上下文 (失败回退预设)"""
    reply = ollama_chat(msg, system=data_context())
    if reply is None:
        reply = f"(ollama 不可用，兜底回复) {gen_reply(msg)}"
    socketio.emit("chat_reply", reply)
    print(f"[chat] Q={msg} A={reply}", flush=True)


@socketio.on("refresh_advice")
def on_refresh_advice(data=None):
    emit_advice()


@socketio.on("refresh_value")
def on_refresh_value(data=None):
    emit_value()


def background_push():
    """每秒检查一次: 若进入新分钟且该分钟无数据, 则生成一次并广播"""
    global last_list, last_disease
    socketio.sleep(1.0)
    while True:
        m = current_minute()
        if m not in data_store:                 # 只初始化一次
            pt = [{"line": random.random()} for _ in range(NUM_CHARTS)]
            data_store[m] = pt
            save_store()
            socketio.emit("point", {"t": m, "charts": pt})
            # 刷新清单: 前 5 项随机, 第 6 项=病害总处数(由病害详情汇总)
            last_disease = gen_disease()
            last_list = [random.randint(LIST_MIN, LIST_MAX) for _ in range(NUM_LIST)]
            last_list[5] = sum(d["count"] for d in last_disease)
            socketio.emit("list", last_list)
            socketio.emit("disease", last_disease)
            print(f"[new] {time.strftime('%Y-%m-%d %H:%M', time.localtime(m))} "
                  f"line={[round(c['line'], 3) for c in pt]} list={last_list} "
                  f"disease={last_disease}", flush=True)
        socketio.sleep(SAMPLE_INTERVAL)


if __name__ == "__main__":
    load_store()
    socketio.start_background_task(background_push)
    print(f"[server] http://localhost:{PORT}/  (Ctrl+C 退出)", flush=True)
    socketio.run(app, host=HOST, port=PORT,
                 allow_unsafe_werkzeug=True, debug=False)
