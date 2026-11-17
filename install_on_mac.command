#!/bin/bash

# ==============================================================================
# Tajweed Pro — Автоматический установщик для MacBook (macOS Intel & Apple Silicon)
# ==============================================================================

set -e

# Переходим в папку проекта
cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"

# Подключаем пути Homebrew для MacBook на Apple Silicon (M1/M2/M3/M4) и Intel
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "=================================================================="
echo "  🕌 Установка Tajweed Pro на ваш MacBook"
echo "  Папка проекта: $PROJECT_DIR"
echo "=================================================================="
echo ""

# Снимаем карантин macOS с файлов проекта
xattr -cr "$PROJECT_DIR" 2>/dev/null || true

# 1. Проверка Homebrew
if ! command -v brew >/dev/null 2>&1; then
  echo "⚠️  Homebrew не найден. Устанавливаем Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
else
  echo "✅ Homebrew найден: $(command -v brew)"
fi

# 2. Проверка Node.js и npm
if ! command -v node >/dev/null 2>&1; then
  echo "📦 Node.js не найден. Устанавливаем через Homebrew..."
  brew install node
else
  echo "✅ Node.js найден: $(node -v)"
fi

# 3. Проверка Python 3
if ! command -v python3 >/dev/null 2>&1; then
  echo "🐍 Python3 не найден. Устанавливаем через Homebrew..."
  brew install python
else
  echo "✅ Python3 найден: $(python3 --version)"
fi

# 4. Проверка и автоматическая установка ffmpeg (для микрофона и Whisper)
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "🎙️ Устанавливаем ffmpeg (необходим для обработки звука и Whisper)..."
  brew install ffmpeg
else
  echo "✅ ffmpeg найден: $(command -v ffmpeg)"
fi

echo ""
echo "------------------------------------------------------------------"
echo "📦 Шаг 1/3: Установка пакетов интерфейса (npm install)..."
echo "------------------------------------------------------------------"
npm install

echo ""
echo "------------------------------------------------------------------"
echo "🐍 Шаг 2/3: Создание виртуального окружения Python и установка ИИ..."
echo "------------------------------------------------------------------"
python3 -m venv quran-ai-backend/.venv
quran-ai-backend/.venv/bin/pip install --upgrade pip
quran-ai-backend/.venv/bin/pip install -r quran-ai-backend/requirements.txt

echo ""
echo "------------------------------------------------------------------"
echo "🚀 Шаг 3/3: Создание ярлыка 'Tajweed Pro.command' на Рабочем столе..."
echo "------------------------------------------------------------------"
chmod +x "$PROJECT_DIR/Tajweed Pro.command"

DESKTOP_LAUNCHER="$HOME/Desktop/Tajweed Pro.command"
cat <<EOF > "$DESKTOP_LAUNCHER"
#!/bin/bash
cd "$PROJECT_DIR" || exit 1
exec "./Tajweed Pro.command"
EOF

chmod +x "$DESKTOP_LAUNCHER"
xattr -cr "$DESKTOP_LAUNCHER" 2>/dev/null || true

echo ""
echo "=================================================================="
echo "  🎉 УСТАНОВКА УСПЕШНО ЗАВЕРШЕНА!"
echo "  Ярлык создан на Рабочем столе: ~/Desktop/Tajweed Pro.command"
echo "  Теперь вы можете запускать Tajweed Pro в 1 клик с Рабочего стола."
echo "=================================================================="
echo ""
echo "Запускаем Tajweed Pro прямо сейчас..."
exec "$PROJECT_DIR/Tajweed Pro.command"
