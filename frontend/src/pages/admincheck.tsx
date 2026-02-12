
export default function Admin_check() {
  return (
<div className="flex h-screen w-screen">
<aside className="flex w-64 flex-col border-r border-border-dark bg-surface-dark">
<div className="flex h-16 items-center gap-3 px-6 border-b border-border-dark">
<div className="text-primary size-8 flex items-center justify-center">
<svg fill="none" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
<path clipRule="evenodd" d="M24 4H6V17.3333V30.6667H24V44H42V30.6667V17.3333H24V4Z" fill="currentColor" fillRule="evenodd"></path>
</svg>
</div>
<h1 className="text-text-primary-dark text-lg font-bold leading-normal">VPN Менеджер</h1>
</div>
<nav className="flex flex-col gap-2 p-4 flex-grow">
<a className="flex items-center gap-3 rounded-lg px-4 py-2 text-text-secondary-dark hover:bg-primary/10 hover:text-primary" href="#">
<span className="material-symbols-outlined text-inherit">dashboard</span>
<p className="text-sm font-medium leading-normal">Дашборд</p>
</a>
<a className="flex items-center gap-3 rounded-lg px-4 py-2 text-text-secondary-dark hover:bg-primary/10 hover:text-primary" href="#">
<span className="material-symbols-outlined text-inherit">group</span>
<p className="text-sm font-medium leading-normal">Пользователи</p>
</a>
<a className="flex items-center gap-3 rounded-lg px-4 py-2 text-white bg-primary" href="#">
<span className="material-symbols-outlined text-inherit !font-bold" style={{fontVariationSettings: "'FILL' 1"}}>credit_card</span>
<p className="text-sm font-medium leading-normal">Оплата VPN</p>
</a>
</nav>
<div className="p-4 border-t border-border-dark">
<a className="flex items-center gap-3 rounded-lg px-4 py-2 text-text-secondary-dark hover:bg-danger/10 hover:text-danger" href="#">
<span className="material-symbols-outlined text-inherit">logout</span>
<p className="text-sm font-medium leading-normal">Выйти</p>
</a>
</div>
</aside>
<div className="flex flex-1 flex-col overflow-y-auto">
<header className="flex h-16 items-center justify-end border-b border-solid border-border-dark bg-surface-dark px-6">
<div className="flex items-center gap-4">
<div className="flex items-center gap-3">
<div className="bg-center bg-no-repeat aspect-square bg-cover rounded-full size-10" data-alt="Admin user avatar" style={{ backgroundImage: 'url("https://lh3.googleusercontent.com/aida-public/AB6AXuBDNVBUWuTbi0rj58hZvhGYvOEibW1_-g8jocTI6w7603tRWrQ--eoTRur0Z9n92CB1so0AdpLN_msCqcCg2CNzPideF-OfuaRfOkKoXbJiGe_JzpVsGtRbHI7wK6iGa6QkxghsVW-QTW-5M04DtQYaQO-NGxUYFk8GcbQXbwUK-ULt_5mbSEb7Wx0S17-AD4gSjuosXTlTc09QFfc-24qc6Hbn-A1mlWF8s4niJQCnEkZigqkSff_LDdm0nwpoAjyKYn6vyWXlbKU")' }}></div>
<div className="flex-col hidden md:flex">
<p className="text-sm font-semibold text-text-primary-dark">Администратор</p>
<p className="text-xs text-text-secondary-dark">admin@vpn.com</p>
</div>
</div>
</div>
</header>
<main className="flex-1 p-6 lg:p-8">
<div className="flex flex-wrap items-center justify-between gap-4 mb-6">
<div className="flex flex-col">
<h1 className="text-3xl font-bold tracking-tight text-text-primary-dark">Оплата VPN</h1>
<p className="text-text-secondary-dark">Просмотр и подтверждение платежей от пользователей.</p>
</div>
</div>
<div className="mb-4 rounded-xl border border-border-dark bg-surface-dark p-4">
<div className="flex flex-col gap-4 md:flex-row md:items-center">
<div className="flex-1">
<label className="relative flex">
<div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
<span className="material-symbols-outlined text-text-secondary-dark">search</span>
</div>
<input className="form-input block h-10 w-full rounded-lg border-border-dark bg-background-dark py-2 pl-10 pr-3 text-sm text-text-primary-dark placeholder:text-text-secondary-dark focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary" placeholder="Поиск по ID пользователя..." type="search"/>
</label>
</div>
<div className="flex items-center gap-2">
<button className="flex h-10 shrink-0 items-center justify-center gap-x-2 rounded-lg bg-primary/20 px-4 text-sm font-medium text-primary hover:bg-primary/30">
                                Новые
                            </button>
<button className="flex h-10 shrink-0 items-center justify-center gap-x-2 rounded-lg bg-background-dark px-4 text-sm font-medium text-text-secondary-dark hover:bg-surface-dark/80">
                                Подтвержденные
                            </button>
<button className="flex h-10 shrink-0 items-center justify-center gap-x-2 rounded-lg bg-background-dark px-4 text-sm font-medium text-text-secondary-dark hover:bg-surface-dark/80">
                                Отклоненные
                            </button>
</div>
</div>
</div>
<div className="overflow-hidden rounded-xl border border-border-dark bg-surface-dark">
<div className="overflow-x-auto">
<table className="min-w-full divide-y divide-border-dark">
<thead className="bg-background-dark/50">
<tr>
<th className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-text-primary-dark sm:pl-6" scope="col">ID пользователя</th>
<th className="px-3 py-3.5 text-left text-sm font-semibold text-text-primary-dark" scope="col">Скриншот оплаты</th>
<th className="px-3 py-3.5 text-left text-sm font-semibold text-text-primary-dark" scope="col">Дата отправки</th>
<th className="relative py-3.5 pl-3 pr-4 sm:pr-6" scope="col"><span className="sr-only">Действия</span></th>
</tr>
</thead>
<tbody className="divide-y divide-border-dark bg-surface-dark">
<tr>
<td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-text-primary-dark sm:pl-6">@john_doe</td>
<td className="whitespace-nowrap px-3 py-4 text-sm">
<button className="flex items-center gap-2 text-primary hover:underline">
<span className="material-symbols-outlined text-inherit" style={{fontSize: 20}}>image</span>
<span>Посмотреть</span>
</button>
</td>
<td className="whitespace-nowrap px-3 py-4 text-sm text-text-secondary-dark">2024-07-22 14:30</td>
<td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-6">
<div className="flex items-center justify-end gap-2">
<button className="flex h-8 items-center justify-center gap-2 rounded-md bg-success/20 px-3 text-xs font-medium text-success hover:bg-success/30">
<span className="material-symbols-outlined text-inherit" style={{fontSize:16}}>check_circle</span>
<span>Подтвердить</span>
</button>
<button className="flex h-8 items-center justify-center gap-2 rounded-md bg-danger/20 px-3 text-xs font-medium text-danger hover:bg-danger/30">
<span className="material-symbols-outlined text-inherit" style={{fontSize:16}}>cancel</span>
<span>Отклонить</span>
</button>
</div>
</td>
</tr>
<tr>
<td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-text-primary-dark sm:pl-6">@jane_smith</td>
<td className="whitespace-nowrap px-3 py-4 text-sm">
<button className="flex items-center gap-2 text-primary hover:underline">
<span className="material-symbols-outlined text-inherit" style={{fontSize: 20}}>image</span>
<span>Посмотреть</span>
</button>
</td>
<td className="whitespace-nowrap px-3 py-4 text-sm text-text-secondary-dark">2024-07-22 11:15</td>
<td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-6">
<div className="flex items-center justify-end gap-2">
<button className="flex h-8 items-center justify-center gap-2 rounded-md bg-success/20 px-3 text-xs font-medium text-success hover:bg-success/30">
<span className="material-symbols-outlined text-inherit" style={{fontSize:16}}>check_circle</span>
<span>Подтвердить</span>
</button>
<button className="flex h-8 items-center justify-center gap-2 rounded-md bg-danger/20 px-3 text-xs font-medium text-danger hover:bg-danger/30">
<span className="material-symbols-outlined text-inherit" style={{fontSize:16}}>cancel</span>
<span>Отклонить</span>
</button>
</div>
</td>
</tr>
<tr>
<td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-text-primary-dark sm:pl-6">@test_user</td>
<td className="whitespace-nowrap px-3 py-4 text-sm">
<button className="flex items-center gap-2 text-primary hover:underline">
<span className="material-symbols-outlined text-inherit" style={{fontSize: 20}}>image</span>
<span>Посмотреть</span>
</button>
</td>
<td className="whitespace-nowrap px-3 py-4 text-sm text-text-secondary-dark">2024-07-21 20:05</td>
<td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-6">
<div className="flex items-center justify-end gap-2">
<button className="flex h-8 items-center justify-center gap-2 rounded-md bg-success/20 px-3 text-xs font-medium text-success hover:bg-success/30">
<span className="material-symbols-outlined text-inherit" style={{fontSize:16}}>check_circle</span>
<span>Подтвердить</span>
</button>
<button className="flex h-8 items-center justify-center gap-2 rounded-md bg-danger/20 px-3 text-xs font-medium text-danger hover:bg-danger/30">
<span className="material-symbols-outlined text-inherit" style={{fontSize:16}}>cancel</span>
<span>Отклонить</span>
</button>
</div>
</td>
</tr>
<tr>
<td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-text-primary-dark sm:pl-6">@sam_wilson</td>
<td className="whitespace-nowrap px-3 py-4 text-sm">
<button className="flex items-center gap-2 text-primary hover:underline">
<span className="material-symbols-outlined text-inherit" style={{fontSize: 20}}>image</span>
<span>Посмотреть</span>
</button>
</td>
<td className="whitespace-nowrap px-3 py-4 text-sm text-text-secondary-dark">2024-07-21 09:48</td>
<td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-6">
<div className="flex items-center justify-end gap-2">
<button className="flex h-8 items-center justify-center gap-2 rounded-md bg-success/20 px-3 text-xs font-medium text-success hover:bg-success/30">
<span className="material-symbols-outlined text-inherit" style={{fontSize:16}}>check_circle</span>
<span>Подтвердить</span>
</button>
<button className="flex h-8 items-center justify-center gap-2 rounded-md bg-danger/20 px-3 text-xs font-medium text-danger hover:bg-danger/30">
<span className="material-symbols-outlined text-inherit" style={{fontSize:16}}>cancel</span>
<span>Отклонить</span>
</button>
</div>
</td>
</tr>
</tbody>
</table>
</div>
<div className="flex items-center justify-between border-t border-border-dark px-4 py-3 sm:px-6">
<div className="flex flex-1 justify-between sm:hidden">
<a className="relative inline-flex items-center rounded-md border border-border-dark bg-surface-dark px-4 py-2 text-sm font-medium text-text-secondary-dark hover:bg-surface-dark/80" href="#">Назад</a>
<a className="relative ml-3 inline-flex items-center rounded-md border border-border-dark bg-surface-dark px-4 py-2 text-sm font-medium text-text-secondary-dark hover:bg-surface-dark/80" href="#">Вперед</a>
</div>
<div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
<div>
<p className="text-sm text-text-secondary-dark">Показано с <span className="font-medium">1</span> по <span className="font-medium">4</span> из <span className="font-medium">25</span> заявок</p>
</div>
<div>
<nav aria-label="Pagination" className="isolate inline-flex -space-x-px rounded-md shadow-sm">
<a className="relative inline-flex items-center rounded-l-md px-2 py-2 text-text-secondary-dark ring-1 ring-inset ring-border-dark hover:bg-surface-dark/80 focus:z-20 focus:outline-offset-0" href="#">
<span className="material-symbols-outlined" style={{fontSize: 20}}>chevron_left</span>
</a>
<a aria-current="page" className="relative z-10 inline-flex items-center bg-primary/10 text-primary px-4 py-2 text-sm font-semibold focus:z-20" href="#">1</a>
<a className="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-text-secondary-dark ring-1 ring-inset ring-border-dark hover:bg-surface-dark/80 focus:z-20" href="#">2</a>
<a className="relative hidden items-center px-4 py-2 text-sm font-semibold text-text-secondary-dark ring-1 ring-inset ring-border-dark hover:bg-surface-dark/80 focus:z-20 md:inline-flex" href="#">3</a>
<span className="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-text-secondary-dark ring-1 ring-inset ring-border-dark">...</span>
<a className="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-text-secondary-dark ring-1 ring-inset ring-border-dark hover:bg-surface-dark/80 focus:z-20" href="#">7</a>
<a className="relative inline-flex items-center rounded-r-md px-2 py-2 text-text-secondary-dark ring-1 ring-inset ring-border-dark hover:bg-surface-dark/80 focus:z-20" href="#">
<span className="material-symbols-outlined" style={{fontSize: 20}}>chevron_right</span>
</a>
</nav>
</div>
</div>
</div>
</div>
</main>
</div>
</div>

)
}
