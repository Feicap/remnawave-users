import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import type { TelegramUser } from '../types/telegram';

const TELEGRAM_BOT_NAME = import.meta.env.VITE_TELEGRAM_BOT_NAME;

declare global {
  interface Window {
    onTelegramAuth: (user: TelegramUser) => void;
  }
}

export default function Auth() {
  const navigate = useNavigate();

  useEffect(() => {
    console.log('Auth useEffect');

    // Telegram callback
    window.onTelegramAuth = async (user: TelegramUser) => {
      console.log('onTelegramAuth called', user);

      try {
        const res = await fetch('/api/auth/telegram/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(user),
        });

        console.log('Server response:', JSON.stringify(user));

        if (!res.ok) {
          const err = await res.json();
          console.error('Auth error:', err);
          alert(`Ошибка авторизации: ${err.error}`);
          return;
        }

        const data = await res.json();
        // Сохраняем данные в localStorage
        localStorage.setItem('tg_user', JSON.stringify(data));
        localStorage.setItem('token', data.token);
        // Сохраняем subscription_url в localStorage
        if (data.subscription_url) {
          localStorage.setItem('subscription_url', data.subscription_url);
        }
        console.log('Auth success, redirecting to /profile');
        navigate('/profile');
      } catch (e) {
        console.error('Network error:', e);
        alert('Ошибка сети');
      }
    };

    // Telegram widget
    const container = document.getElementById('telegram-login-widget');
    if (!container) return;
    container.innerHTML = '';

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', TELEGRAM_BOT_NAME);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '0');
    script.setAttribute('data-userpic', 'true');
    script.setAttribute('data-request-access', 'write');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');

    container.appendChild(script);
  }, [navigate]);

  return (
    <div className="relative flex h-screen w-full flex-col bg-background-light dark:bg-background-dark overflow-x-hidden font-display">
      <div className="layout-container flex h-full grow flex-col">
        <div className="px-4 md:px-10 lg:px-40 flex flex-1 justify-center py-5">
          <div className="layout-content-container flex flex-col w-full max-w-[960px] flex-1">
            <main className="flex-grow flex items-center justify-center p-4">
              <div className="w-full max-w-4xl @container">
                <div className="flex flex-col items-center justify-start rounded-xl @[768px]:flex-row @[768px]:items-start bg-white dark:bg-[#192233] shadow-sm">
                  {/* Левая колонка: текст + Telegram */}
                  <div className="flex w-full min-w-72 grow flex-col items-stretch justify-center gap-4 p-8 @[768px]:w-1/2">
                    <h1 className="text-slate-500 dark:text-[#92a4c9] text-sm font-medium leading-normal">
                      БЕЗОПАСНЫЙ ВХОД
                    </h1>
                    <p className="text-slate-800 dark:text-white text-2xl font-bold leading-tight tracking-[-0.015em]">
                      Авторизуйтесь через Telegram.
                    </p>

                    {/* Telegram Login Widget Button */}
                    <div
                      id="telegram-login-widget"
                      style={{
                        textAlign: 'center',
                        marginTop: '1rem',
                        display: 'flex',
                        justifyContent: 'center',
                        
                      }}
                    />
                  </div>

                  {/* Правая колонка: QR-код */}
                  <div className="w-full p-8 bg-slate-100 dark:bg-black/20 @[768px]:w-1/2 rounded-b-xl @[768px]:rounded-l-none @[768px]:rounded-r-xl flex flex-col items-center justify-center gap-4 aspect-square @[768px]:aspect-auto @[768px]:h-auto">
                    <div className="w-full max-w-64 bg-white p-4 rounded-lg shadow">
                      <img
                        className="w-full aspect-square"
                        alt="QR-код для входа в Telegram"
                        src="https://upload.wikimedia.org/wikipedia/commons/2/2f/Rickrolling_QR_code.png"
                      />
                    </div>
                    <p className="text-slate-600 dark:text-[#92a4c9] text-center text-sm font-normal leading-normal">
                      Или отсканируйте этот код камерой телефона.
                    </p>
                  </div>
                </div>
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

