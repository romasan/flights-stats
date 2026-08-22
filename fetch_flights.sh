#!/bin/bash

# 0. Определение директории скрипта. Важно при запуске из cron:
#    рабочая директория по умолчанию — домашняя, а не директория скрипта.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Определение ОС для корректного получения вчерашней даты
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS (BSD date)
    YESTERDAY=$(date -v-1d +%Y%m%d)
else
    # Linux / Debian (GNU date)
    YESTERDAY=$(date -d "yesterday" +%Y%m%d)
fi

# 2. URL-адреса API
ARRIVAL_URL="https://pulkovoairport.ru/api/?type=arrival&when=-1"
DEPARTURE_URL="https://pulkovoairport.ru/api/?type=departure&when=-1"

# 3. Имена выходных файлов (абсолютные пути — рядом со скриптом)
ARRIVAL_FILE="${SCRIPT_DIR}/arrival-${YESTERDAY}.json"
DEPARTURE_FILE="${SCRIPT_DIR}/departure-${YESTERDAY}.json"

# 4. User-Agent для обхода базовой защиты от ботов (имитация обычного браузера)
USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"

echo "📅 Начинаем загрузку данных за ${YESTERDAY}..."

# 5. Загрузка данных о прилетах
echo "⬇️ Загрузка прилетов..."
if curl -s -f -A "$USER_AGENT" -o "$ARRIVAL_FILE" "$ARRIVAL_URL"; then
    echo "✅ Успешно сохранено в $ARRIVAL_FILE"
else
    echo "❌ Ошибка при загрузке данных о прилетах!"
fi

# 6. Загрузка данных о вылетах
echo "⬇️ Загрузка вылетов..."
if curl -s -f -A "$USER_AGENT" -o "$DEPARTURE_FILE" "$DEPARTURE_URL"; then
    echo "✅ Успешно сохранено в $DEPARTURE_FILE"
else
    echo "❌ Ошибка при загрузке данных о вылетах!"
fi

echo "🎉 Готово!"
