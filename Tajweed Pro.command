#!/bin/bash

# ==============================================================================
# Tajweed Pro — Запуск в 1 клик для MacBook (macOS)
# ==============================================================================

cd "$(dirname "$0")" || exit 1
PROJECT_DIR="$(pwd)"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "=================================================================="
echo "  🕌 Запуск Tajweed Pro (AI Quran Trainer)"
echo "=================================================================="

# 1. Очищаем старые процессы на портах 8000 и 3000
echo "🔄 Освобождение портов 8000 и 3000..."
lsof -ti:8000,3000 | xargs kill -9 2>/dev/null || true
sleep 1

mkdir -p "$PROJECT_DIR/logs"

# Проверяем, что виртуальное окружение создано
if [ ! -f "$PROJECT_DIR/quran-ai-backend/.venv/bin/python" ]; then
  echo "⚠️  Виртуальное окружение не найдено! Запускаем первичную установку..."
  chmod +x "$PROJECT_DIR/install_on_mac.command"
  exec "$PROJECT_DIR/install_on_mac.command"
fi

# 2. Запускаем в фоне FastAPI бэкенд из папки quran-ai-backend
echo "🧠 Запуск ИИ-сервера анализа таджвида (порт 8000)..."
(
  cd "$PROJECT_DIR/quran-ai-backend" && \
  "$PROJECT_DIR/quran-ai-backend/.venv/bin/python" -m uvicorn main:app --host 127.0.0.1 --port 8000 \
  > "$PROJECT_DIR/logs/backend.log" 2>&1
) &
BACKEND_PID=$!

# 3. Запускаем в фоне Next.js фронтенд на порту 3000
echo "💻 Запуск графического интерфейса Мусхафа (порт 3000)..."
(
  cd "$PROJECT_DIR" && \
  npm run dev -- -p 3000 \
  > "$PROJECT_DIR/logs/frontend.log" 2>&1
) &
FRONTEND_PID=$!

# 4. Ожидаем готовности http://127.0.0.1:8000/docs и http://127.0.0.1:3000 (HTTP 200)
echo -n "⏳ Ожидание готовности серверов"
MAX_WAIT=45
COUNT=0
BACKEND_READY=0
FRONTEND_READY=0

while [ $COUNT -lt $MAX_WAIT ]; do
  if [ $BACKEND_READY -eq 0 ]; then
    STATUS_8000=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/docs || echo "000")
    if [ "$STATUS_8000" = "200" ]; then
      BACKEND_READY=1
    fi
  fi

  if [ $FRONTEND_READY -eq 0 ]; then
    STATUS_3000=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000 || echo "000")
    if [ "$STATUS_3000" = "200" ]; then
      FRONTEND_READY=1
    fi
  fi

  if [ $BACKEND_READY -eq 1 ] && [ $FRONTEND_READY -eq 1 ]; then
    break
  fi

  echo -n "."
  sleep 1
  COUNT=$((COUNT + 1))
done

echo ""
echo "✅ Серверы готовы! Открываем окно Tajweed Pro..."

# 5. Автоматически открываем окно приложения в Chrome App Mode или браузере по умолчанию
if [ -d "/Applications/Google Chrome.app" ]; then
  open -a "Google Chrome" --args --app=http://localhost:3000
else
  open http://localhost:3000
fi

echo ""
echo "=================================================================="
echo "  🟢 Tajweed Pro работает! Адрес: http://localhost:3000"
echo "  Не закрывайте это окно во время занятия."
echo "  Для остановки программы нажмите Ctrl+C или просто закройте окно."
echo "=================================================================="

trap "lsof -ti:8000,3000 | xargs kill -9 2>/dev/null || true; exit 0" INT TERM EXIT
wait $BACKEND_PID $FRONTEND_PID
