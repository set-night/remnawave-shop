# Remnawave Shop Bot

Telegram бот для управления подписками на сервис Remnawave.

## Функционал

- Покупка подписок через:
  - Telegram Stars
  - CryptoBot
- Пробный период
- Реферальная программа
- Управление активными подписками
- Конструктор кастомных тарифов
- Мультиязычная поддержка (русский/английский)

## Установка

1. Клонируйте репозиторий:
```bash
git clone https://github.com/set-night/remnawave-shop.git
cd remnawave-shop
```

2. Настройте переменные окружения:
```bash
cp .env.example .env
```

Отредактируйте файл `.env`

3. Запустите сервисы через Docker:
```bash
docker-compose up -d
```