use crate::action::{Action, Field, LedgerTransport, NetworkChoice, SettingsAction, Tab};
use crate::app::{App, Hit, ScreenKind};
use crate::format::mask_secret;
use crate::settings::{
    ComputeBackend, NodeMode, NodePreset, ProtectionMode, WorkerKind, AUTO_LOCK_OPTIONS, LANGUAGES,
    PRIVATE_WORKER_PAIRING, PROJECT_ADDRESSES, PROJECT_SERVICES,
};
use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers,
    MouseButton, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Gauge, Paragraph, Wrap};
use ratatui::Frame;
use ratatui::Terminal;
use std::io::{self, Stdout};
use std::time::Duration;

/// Desktop GUI palette (`wallets/desktop/src/styles.css`).
const BG: Color = Color::Rgb(7, 6, 13);
const SIDEBAR: Color = Color::Rgb(14, 11, 24);
const SIDEBAR_EDGE: Color = Color::Rgb(41, 36, 60);
const CARD: Color = Color::Rgb(18, 16, 29);
const CARD_EDGE: Color = Color::Rgb(52, 45, 71);
const INPUT: Color = Color::Rgb(13, 11, 20);
const ORANGE: Color = Color::Rgb(250, 103, 28);
const ORANGE_SOFT: Color = Color::Rgb(255, 177, 134);
const ORANGE_DIM: Color = Color::Rgb(43, 27, 40);
const TEXT: Color = Color::Rgb(246, 245, 251);
const MUTED: Color = Color::Rgb(165, 157, 182);
const NAV: Color = Color::Rgb(180, 174, 192);
const DANGER: Color = Color::Rgb(255, 92, 118);
const OK: Color = Color::Rgb(0, 214, 143);
const AMBER: Color = Color::Rgb(244, 189, 85);
const TRACK: Color = Color::Rgb(40, 34, 54);
const PRIMARY_FG: Color = Color::Rgb(33, 16, 26);

const SIDEBAR_WIDTH: u16 = 24;

pub fn run(mut app: App) -> io::Result<crate::app::RunOutcome> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let result = event_loop(&mut terminal, &mut app);
    let _ = restore_terminal(&mut terminal);
    result
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> io::Result<()> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;
    Ok(())
}

fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    app: &mut App,
) -> io::Result<crate::app::RunOutcome> {
    loop {
        terminal.draw(|frame| draw(app, frame))?;
        if event::poll(Duration::from_millis(200))? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => {
                    if let Some(action) = map_key(app, key.code, key.modifiers) {
                        match app.handle(action) {
                            crate::app::RunOutcome::Continue => {}
                            other => return Ok(other),
                        }
                    }
                }
                Event::Mouse(mouse) if mouse.kind == MouseEventKind::Down(MouseButton::Left) => {
                    match app.handle(Action::MouseClick {
                        column: mouse.column,
                        row: mouse.row,
                    }) {
                        crate::app::RunOutcome::Continue => {}
                        other => return Ok(other),
                    }
                }
                Event::Mouse(mouse)
                    if matches!(
                        mouse.kind,
                        MouseEventKind::ScrollDown | MouseEventKind::ScrollUp
                    ) =>
                {
                    let delta = if mouse.kind == MouseEventKind::ScrollDown {
                        3
                    } else {
                        -3
                    };
                    let _ = app.handle(Action::Settings(SettingsAction::Scroll(delta)));
                }
                Event::Resize(_, _) => {}
                _ => {}
            }
        } else if let crate::app::RunOutcome::Exit(code) = app.handle(Action::Tick) {
            return Ok(crate::app::RunOutcome::Exit(code));
        }
    }
}

fn map_key(app: &App, code: KeyCode, modifiers: KeyModifiers) -> Option<Action> {
    if modifiers.contains(KeyModifiers::CONTROL) && matches!(code, KeyCode::Char('c')) {
        return Some(Action::Quit);
    }
    match code {
        KeyCode::Esc => Some(Action::Cancel),
        KeyCode::PageDown => Some(Action::Settings(SettingsAction::Scroll(6))),
        KeyCode::PageUp => Some(Action::Settings(SettingsAction::Scroll(-6))),
        KeyCode::Down
            if matches!(
                app.view_model().screen,
                ScreenKind::Settings | ScreenKind::Node | ScreenKind::Project | ScreenKind::Menu
            ) =>
        {
            Some(Action::Settings(SettingsAction::Scroll(2)))
        }
        KeyCode::Up
            if matches!(
                app.view_model().screen,
                ScreenKind::Settings | ScreenKind::Node | ScreenKind::Project | ScreenKind::Menu
            ) =>
        {
            Some(Action::Settings(SettingsAction::Scroll(-2)))
        }
        KeyCode::Tab => {
            if app.view_model().wallet_open {
                Some(Action::GoTab(app.view_model().tab.next()))
            } else {
                Some(Action::Focus(next_field(app)))
            }
        }
        KeyCode::BackTab => {
            if app.view_model().wallet_open {
                Some(Action::GoTab(app.view_model().tab.previous()))
            } else {
                None
            }
        }
        KeyCode::Enter => Some(enter_action(app)),
        KeyCode::Backspace => Some(Action::Backspace),
        KeyCode::F(5) => Some(Action::Refresh),
        KeyCode::Char(ch) => {
            if app.focused_field() == Field::Command || typing_screen(app) {
                Some(Action::InsertChar(ch))
            } else {
                match ch {
                    'q' => Some(Action::Quit),
                    'b' => Some(Action::GoTab(Tab::Home)),
                    'a' => Some(Action::GoTab(Tab::Receive)),
                    's' => Some(Action::GoTab(Tab::Send)),
                    'm' => Some(Action::GoTab(Tab::Menu)),
                    'r' => Some(Action::Refresh),
                    'h' | '?' => Some(Action::GoTab(Tab::Help)),
                    '/' => Some(Action::Focus(Field::Command)),
                    _ => Some(Action::InsertChar(ch)),
                }
            }
        }
        _ => None,
    }
}

fn typing_screen(app: &App) -> bool {
    matches!(
        app.view_model().screen,
        ScreenKind::Create
            | ScreenKind::Open
            | ScreenKind::Restore
            | ScreenKind::Ledger
            | ScreenKind::Send
    ) || matches!(
        app.focused_field(),
        Field::Command
            | Field::SubaddressLabel
            | Field::PrivateWorker
            | Field::AppPassword
            | Field::AppPasswordConfirm
            | Field::CurrentAppPassword
            | Field::MfwName
            | Field::NodeDaemon
            | Field::NodeGrpc
            | Field::NodeProxy
    )
}

fn next_field(app: &App) -> Field {
    match app.view_model().screen {
        ScreenKind::Create | ScreenKind::Open | ScreenKind::Ledger => match app.focused_field() {
            Field::WalletPath => Field::Password,
            Field::Password => Field::RestoreHeight,
            _ => Field::WalletPath,
        },
        ScreenKind::Restore => match app.focused_field() {
            Field::WalletPath => Field::Password,
            Field::Password => Field::Seed,
            Field::Seed => Field::RestoreHeight,
            _ => Field::WalletPath,
        },
        ScreenKind::Send => match app.focused_field() {
            Field::Address => Field::Amount,
            _ => Field::Address,
        },
        _ => Field::Command,
    }
}

fn enter_action(app: &App) -> Action {
    if app.focused_field() == Field::Command && !app.view_model().command.is_empty() {
        return Action::RunCommand;
    }
    match app.view_model().screen {
        ScreenKind::Welcome => Action::SelectOpen,
        ScreenKind::SeedBackup => Action::ConfirmSeedBackup,
        ScreenKind::Send if app.view_model().review.is_some() => Action::ConfirmSend,
        ScreenKind::Send => Action::ReviewSend,
        ScreenKind::Receive => Action::NewSubaddress,
        ScreenKind::Home | ScreenKind::Activity => Action::Refresh,
        ScreenKind::Settings if app.focused_field() == Field::PrivateWorker => {
            Action::Settings(SettingsAction::UsePrivateWorker)
        }
        ScreenKind::Settings
            if matches!(
                app.focused_field(),
                Field::AppPassword | Field::AppPasswordConfirm | Field::CurrentAppPassword
            ) =>
        {
            Action::Settings(SettingsAction::SaveProtection)
        }
        ScreenKind::Menu => Action::OpenMenu(crate::settings::MenuItem::Settings),
        ScreenKind::Node => Action::Settings(SettingsAction::RunDiagnostics),
        ScreenKind::Mfw if app.view_model().settings.mfw_available => {
            Action::Settings(SettingsAction::ContinueMfw)
        }
        ScreenKind::Mfw => Action::Settings(SettingsAction::CheckMfwName),
        _ => Action::Submit,
    }
}

pub fn draw(app: &mut App, frame: &mut Frame<'_>) {
    app.hits.clear();
    let area = frame.area();
    frame.render_widget(Clear, area);
    frame.render_widget(
        Block::default().style(Style::default().bg(BG).fg(TEXT)),
        area,
    );

    let with_sidebar = area.width >= 72;
    let columns = if with_sidebar {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(SIDEBAR_WIDTH), Constraint::Min(40)])
            .split(area)
    } else {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(0), Constraint::Min(40)])
            .split(area)
    };

    if with_sidebar {
        draw_sidebar(app, frame, columns[0]);
    }

    let main = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(if with_sidebar { 3 } else { 4 }),
            Constraint::Min(8),
            Constraint::Length(2),
        ])
        .split(columns[1]);

    draw_topbar(app, frame, main[0], !with_sidebar);
    draw_body(app, frame, main[1]);
    draw_footer(app, frame, main[2]);
}

fn draw_sidebar(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let model = app.view_model();
    frame.render_widget(
        Block::default()
            .style(Style::default().bg(SIDEBAR).fg(TEXT))
            .borders(Borders::RIGHT)
            .border_style(Style::default().fg(SIDEBAR_EDGE)),
        area,
    );
    let inner = Rect {
        x: area.x + 1,
        y: area.y + 1,
        width: area.width.saturating_sub(2),
        height: area.height.saturating_sub(2),
    };

    let brand = vec![
        Line::from(Span::styled(
            "  ◈",
            Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
        )),
        Line::from(vec![
            Span::styled(
                "  Monero",
                Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                " Fast",
                Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(Span::styled("  Wallet", Style::default().fg(TEXT))),
        Line::from(Span::styled("  TEX8 · TUI", Style::default().fg(MUTED))),
        Line::from(""),
    ];
    frame.render_widget(Paragraph::new(brand), inner);

    let items: Vec<(&str, Action, bool)> = if model.wallet_open {
        Tab::ALL
            .iter()
            .map(|tab| (tab.title(), Action::GoTab(*tab), model.tab == *tab))
            .collect()
    } else {
        vec![
            (
                "Welcome",
                Action::Cancel,
                model.screen == ScreenKind::Welcome,
            ),
            ("Open", Action::SelectOpen, model.screen == ScreenKind::Open),
            (
                "Create",
                Action::SelectCreate,
                model.screen == ScreenKind::Create,
            ),
            (
                "Ledger",
                Action::SelectLedger,
                model.screen == ScreenKind::Ledger,
            ),
            (
                "Restore",
                Action::SelectRestore,
                matches!(model.screen, ScreenKind::Restore | ScreenKind::SeedBackup),
            ),
        ]
    };

    let mut y = inner.y + 6;
    for (label, action, active) in items {
        let row = Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 1,
        };
        let style = if active {
            Style::default()
                .fg(TEXT)
                .bg(ORANGE_DIM)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(NAV).bg(SIDEBAR)
        };
        let marker = if active { "▸" } else { " " };
        let icon_style = if active {
            Style::default().fg(ORANGE).bg(ORANGE_DIM)
        } else {
            Style::default().fg(MUTED).bg(SIDEBAR)
        };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(format!(" {marker} "), icon_style),
                Span::styled(format!("{label:<12}"), style),
            ])),
            row,
        );
        app.hits.push(Hit {
            x: row.x,
            y: row.y,
            width: row.width,
            height: 1,
            action,
        });
        y += 2;
    }

    let foot = Rect {
        x: inner.x,
        y: inner.y.saturating_add(inner.height.saturating_sub(4)),
        width: inner.width,
        height: 4,
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                "─────────────",
                Style::default().fg(SIDEBAR_EDGE),
            )),
            Line::from(Span::styled(
                format!(" ● {}", model.network),
                Style::default().fg(OK),
            )),
            Line::from(Span::styled(" Developed with", Style::default().fg(MUTED))),
            Line::from(vec![
                Span::styled(" ♥ ", Style::default().fg(ORANGE)),
                Span::styled("by TEX8", Style::default().fg(MUTED)),
            ]),
        ]),
        foot,
    );
}

fn draw_topbar(app: &mut App, frame: &mut Frame<'_>, area: Rect, compact_nav: bool) {
    let model = app.view_model();
    let title = match model.screen {
        ScreenKind::Welcome => "MONERO FAST WALLET",
        ScreenKind::Open => "Open wallet",
        ScreenKind::Create => "Create wallet",
        ScreenKind::Restore => "Restore wallet",
        ScreenKind::Ledger => "Ledger Nano",
        ScreenKind::SeedBackup => "Recovery seed",
        ScreenKind::Home => "Home",
        ScreenKind::Receive => "Receive Monero",
        ScreenKind::Send => "Send Monero",
        ScreenKind::Activity => "Activity",
        ScreenKind::Help => "Help",
        ScreenKind::Menu => "Menu",
        ScreenKind::Settings => "Settings",
        ScreenKind::Wallets => "Manage wallets",
        ScreenKind::Node => "Node Status",
        ScreenKind::Mfw => "Your Address Names",
        ScreenKind::Project => "Project Page & Services",
    };
    let left = Rect {
        x: area.x + 2,
        y: area.y,
        width: area.width.saturating_sub(24),
        height: 2,
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                title,
                Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                if model.wallet_open {
                    "Self-custodial · seed stays on this device"
                } else {
                    "Choose a wallet to continue"
                },
                Style::default().fg(MUTED),
            )),
        ]),
        left,
    );
    let pill = Rect {
        x: area.x.saturating_add(area.width.saturating_sub(20)),
        y: area.y,
        width: 18,
        height: 1,
    };
    frame.render_widget(
        Paragraph::new(format!(" {} ", model.network))
            .alignment(Alignment::Right)
            .style(
                Style::default()
                    .fg(ORANGE)
                    .bg(ORANGE_DIM)
                    .add_modifier(Modifier::BOLD),
            ),
        pill,
    );
    if compact_nav {
        let nav_y = area.y.saturating_add(2);
        let labels = if model.wallet_open {
            vec![
                ("Home", Action::GoTab(Tab::Home)),
                ("Send", Action::GoTab(Tab::Send)),
                ("Receive", Action::GoTab(Tab::Receive)),
                ("Menu", Action::GoTab(Tab::Menu)),
            ]
        } else {
            vec![
                ("Welcome", Action::Cancel),
                ("Open", Action::SelectOpen),
                ("Create", Action::SelectCreate),
                ("Ledger", Action::SelectLedger),
                ("Restore", Action::SelectRestore),
            ]
        };
        let mut x = area.x + 2;
        for (label, action) in labels {
            let w = label.len() as u16 + 3;
            draw_chip(app, frame, x, nav_y, label, action, false);
            x += w + 1;
        }
    }
}

fn draw_body(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let padded = shrink(area, 1, 0, 2, 1);
    match app.view_model().screen {
        ScreenKind::Welcome => draw_welcome(app, frame, padded),
        ScreenKind::Create => draw_form(app, frame, padded, false, false),
        ScreenKind::Open => draw_form(app, frame, padded, false, false),
        ScreenKind::Restore => draw_form(app, frame, padded, true, true),
        ScreenKind::Ledger => draw_ledger(app, frame, padded),
        ScreenKind::SeedBackup => draw_seed(app, frame, padded),
        ScreenKind::Home => draw_home(app, frame, padded),
        ScreenKind::Receive => draw_receive(app, frame, padded),
        ScreenKind::Send => draw_send(app, frame, padded),
        ScreenKind::Activity => draw_activity(app, frame, padded),
        ScreenKind::Help => draw_help(app, frame, padded),
        ScreenKind::Menu => draw_menu(app, frame, padded),
        ScreenKind::Settings => draw_settings(app, frame, padded),
        ScreenKind::Wallets => draw_wallets(app, frame, padded),
        ScreenKind::Node => draw_node(app, frame, padded),
        ScreenKind::Mfw => draw_mfw(app, frame, padded),
        ScreenKind::Project => draw_project(app, frame, padded),
    }
}

fn draw_welcome(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let model = app.view_model();
    let intro = Rect {
        x: area.x,
        y: area.y,
        width: area.width,
        height: 4,
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                "MONERO FAST WALLET",
                Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                "Self-custodial. Seed and spend key stay on this device.",
                Style::default().fg(MUTED),
            )),
            Line::from(Span::styled(model.backend, Style::default().fg(MUTED))),
        ]),
        intro,
    );

    let cards = [
        (
            "Open wallet",
            "Use an existing .keys file in this folder",
            Action::SelectOpen,
            true,
        ),
        (
            "Create wallet",
            "New self-custodial wallet · 25-word seed",
            Action::SelectCreate,
            false,
        ),
        (
            "Ledger Nano",
            "Use USB or Bluetooth. Seed stays on the device.",
            Action::SelectLedger,
            false,
        ),
        (
            "Restore from seed",
            "Recover from 25 words written offline",
            Action::SelectRestore,
            false,
        ),
    ];
    let mut y = area.y + 5;
    for (title, subtitle, action, primary) in cards {
        if y.saturating_add(4) > area.y.saturating_add(area.height) {
            break;
        }
        let card = Rect {
            x: area.x,
            y,
            width: area.width.min(64),
            height: 4,
        };
        let border = if primary { ORANGE } else { CARD_EDGE };
        let fill = if primary { ORANGE_DIM } else { CARD };
        frame.render_widget(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(border))
                .style(Style::default().bg(fill)),
            card,
        );
        let inner = shrink(card, 1, 1, 2, 1);
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    title,
                    Style::default()
                        .fg(if primary { ORANGE_SOFT } else { TEXT })
                        .add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(subtitle, Style::default().fg(MUTED))),
            ]),
            inner,
        );
        app.hits.push(Hit {
            x: card.x,
            y: card.y,
            width: card.width,
            height: card.height,
            action,
        });
        y += 5;
    }

    let extras_y = y.saturating_add(1);
    if extras_y < area.y.saturating_add(area.height) {
        draw_chip(
            app,
            frame,
            area.x,
            extras_y,
            "Classic CLI",
            Action::LaunchClassic,
            false,
        );
        draw_chip(
            app,
            frame,
            area.x + 16,
            extras_y,
            "Quit",
            Action::Quit,
            false,
        );
    }
}

fn draw_form(app: &mut App, frame: &mut Frame<'_>, area: Rect, show_seed: bool, _unused: bool) {
    let model = app.view_model();
    let card = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(CARD_EDGE))
        .style(Style::default().bg(CARD).fg(TEXT))
        .title(Span::styled(
            format!("  {}  ", model.header),
            Style::default().fg(ORANGE),
        ));
    frame.render_widget(card, area);
    let inner = shrink(area, 2, 1, 3, 2);

    let mut y = inner.y;
    frame.render_widget(
        Paragraph::new(Span::styled(
            format!("Looking in  {}", model.working_dir),
            Style::default().fg(MUTED),
        )),
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 1,
        },
    );
    y += 2;

    y = draw_input(
        app,
        frame,
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 4,
        },
        "Wallet file",
        &field_value(&model.wallet_path, model.focused == Field::WalletPath),
        Field::WalletPath,
    );
    y = draw_input(
        app,
        frame,
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 4,
        },
        "Password",
        &field_value(
            model.password_masked.as_deref().unwrap_or(""),
            model.focused == Field::Password,
        ),
        Field::Password,
    );
    if show_seed {
        y = draw_input(
            app,
            frame,
            Rect {
                x: inner.x,
                y,
                width: inner.width,
                height: 4,
            },
            "Recovery seed",
            if model.focused == Field::Seed {
                "••••  typing hidden  █"
            } else {
                "25 words · never a CLI argument"
            },
            Field::Seed,
        );
        y = draw_input(
            app,
            frame,
            Rect {
                x: inner.x,
                y,
                width: inner.width,
                height: 4,
            },
            "Restore height",
            &field_value(&model.restore_height, model.focused == Field::RestoreHeight),
            Field::RestoreHeight,
        );
    }

    frame.render_widget(
        Paragraph::new(Span::styled("Network", Style::default().fg(MUTED))),
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 1,
        },
    );
    y += 1;
    let mut nx = inner.x;
    for network in [
        NetworkChoice::Mainnet,
        NetworkChoice::Stagenet,
        NetworkChoice::Testnet,
    ] {
        let selected = model.network == network.label();
        draw_chip(
            app,
            frame,
            nx,
            y,
            network.label(),
            Action::SetNetwork(network),
            selected,
        );
        nx += network.label().len() as u16 + 4;
    }
    y += 2;

    if model.known_wallets.is_empty() {
        frame.render_widget(
            Paragraph::new(Span::styled(
                "No .keys wallets found in the Desktop app folder or this folder.",
                Style::default().fg(MUTED),
            )),
            Rect {
                x: inner.x,
                y,
                width: inner.width,
                height: 2,
            },
        );
        y += 2;
    } else {
        frame.render_widget(
            Paragraph::new(Span::styled(
                "Existing wallets — click to fill",
                Style::default().fg(MUTED),
            )),
            Rect {
                x: inner.x,
                y,
                width: inner.width,
                height: 1,
            },
        );
        y += 1;
        for wallet in model.known_wallets.iter().take(10) {
            let row = Rect {
                x: inner.x,
                y,
                width: inner.width,
                height: 2,
            };
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(Span::styled(
                        format!("▸ {}", wallet.label),
                        Style::default()
                            .fg(ORANGE_SOFT)
                            .add_modifier(Modifier::BOLD),
                    )),
                    Line::from(Span::styled(
                        format!("  {}", wallet.detail),
                        Style::default().fg(MUTED),
                    )),
                ])
                .style(Style::default().bg(INPUT)),
                row,
            );
            app.hits.push(Hit {
                x: row.x,
                y: row.y,
                width: row.width,
                height: 2,
                action: Action::SetWalletPath(wallet.path.clone()),
            });
            y += 2;
        }
    }

    let by = inner
        .y
        .saturating_add(inner.height.saturating_sub(2))
        .max(y + 1);
    let submit = match model.screen {
        ScreenKind::Create => "Create",
        ScreenKind::Restore => "Restore",
        _ => "Open",
    };
    draw_primary(app, frame, inner.x, by, submit, Action::Submit);
    draw_chip(
        app,
        frame,
        inner.x + submit.len() as u16 + 6,
        by,
        "Cancel",
        Action::Cancel,
        false,
    );
    if model.screen == ScreenKind::Open {
        draw_chip(
            app,
            frame,
            inner.x + submit.len() as u16 + 16,
            by,
            "Create instead",
            Action::SelectCreate,
            false,
        );
    }
}

fn draw_ledger(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let model = app.view_model();
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(ORANGE))
            .style(Style::default().bg(CARD))
            .title(Span::styled("  Ledger Nano  ", Style::default().fg(ORANGE))),
        area,
    );
    let inner = shrink(area, 2, 1, 3, 2);
    let mut y = inner.y;
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                "Connect and unlock the Ledger, open its Monero app, then choose USB or Bluetooth.",
                Style::default().fg(MUTED),
            )),
            Line::from(Span::styled(
                "The recovery seed remains on the device. Fast Wallet is optional later.",
                Style::default().fg(MUTED),
            )),
        ]),
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 2,
        },
    );
    y += 3;
    frame.render_widget(
        Paragraph::new(Span::styled("Transport", Style::default().fg(MUTED))),
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 1,
        },
    );
    y += 1;
    draw_chip(
        app,
        frame,
        inner.x,
        y,
        "USB",
        Action::SetLedgerTransport(LedgerTransport::Usb),
        model.ledger_transport == LedgerTransport::Usb,
    );
    draw_chip(
        app,
        frame,
        inner.x + 8,
        y,
        "Bluetooth",
        Action::SetLedgerTransport(LedgerTransport::Ble),
        model.ledger_transport == LedgerTransport::Ble,
    );
    y += 2;
    let hint = if model.ledger_transport == LedgerTransport::Ble {
        "Search for an unlocked Ledger Nano X over Bluetooth."
    } else {
        "Connect the Ledger by USB, unlock it, and open the Monero app."
    };
    frame.render_widget(
        Paragraph::new(Span::styled(hint, Style::default().fg(AMBER))),
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 1,
        },
    );
    y += 2;
    y = draw_input(
        app,
        frame,
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 4,
        },
        "Wallet file",
        &field_value(&model.wallet_path, model.focused == Field::WalletPath),
        Field::WalletPath,
    );
    y = draw_input(
        app,
        frame,
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 4,
        },
        "Local cache password",
        &field_value(
            model.password_masked.as_deref().unwrap_or(""),
            model.focused == Field::Password,
        ),
        Field::Password,
    );
    y = draw_input(
        app,
        frame,
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 4,
        },
        "Scan start height (required, before first transaction)",
        &field_value(&model.restore_height, model.focused == Field::RestoreHeight),
        Field::RestoreHeight,
    );
    frame.render_widget(
        Paragraph::new(Span::styled("Network", Style::default().fg(MUTED))),
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 1,
        },
    );
    y += 1;
    let mut nx = inner.x;
    for network in [
        NetworkChoice::Mainnet,
        NetworkChoice::Stagenet,
        NetworkChoice::Testnet,
    ] {
        draw_chip(
            app,
            frame,
            nx,
            y,
            network.label(),
            Action::SetNetwork(network),
            model.network == network.label(),
        );
        nx += network.label().len() as u16 + 4;
    }
    draw_primary(
        app,
        frame,
        inner.x,
        inner.y.saturating_add(inner.height.saturating_sub(2)),
        "Connect Ledger",
        Action::Submit,
    );
    draw_chip(
        app,
        frame,
        inner.x + 20,
        inner.y.saturating_add(inner.height.saturating_sub(2)),
        "Cancel",
        Action::Cancel,
        false,
    );
}

fn draw_seed(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let words = app.seed_words().unwrap_or("");
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(ORANGE))
            .style(Style::default().bg(CARD))
            .title(Span::styled(
                "  Write these 25 words down offline  ",
                Style::default().fg(ORANGE),
            )),
        area,
    );
    let inner = shrink(area, 2, 1, 3, 2);
    let mut lines = vec![
        Line::from(Span::styled(
            "Shown once. Do not store them in email or cloud.",
            Style::default().fg(DANGER).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];
    let list: Vec<&str> = words.split_whitespace().collect();
    for (index, chunk) in list.chunks(5).enumerate() {
        let numbered: String = chunk
            .iter()
            .enumerate()
            .map(|(i, word)| format!("{:>2}. {:<12}", index * 5 + i + 1, word))
            .collect::<Vec<_>>()
            .join("");
        lines.push(Line::from(Span::styled(
            numbered,
            Style::default()
                .fg(ORANGE_SOFT)
                .add_modifier(Modifier::BOLD),
        )));
    }
    frame.render_widget(Paragraph::new(lines), inner);
    let button_y = inner.y.saturating_add(inner.height.saturating_sub(2));
    draw_primary(
        app,
        frame,
        inner.x,
        button_y,
        "I have written the seed down",
        Action::ConfirmSeedBackup,
    );
    app.hits.push(Hit {
        x: inner.x,
        y: button_y.saturating_sub(1),
        width: inner.width,
        height: 3,
        action: Action::ConfirmSeedBackup,
    });
}

fn draw_home(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let model = app.view_model();
    let balance = model
        .balance
        .clone()
        .unwrap_or_else(|| "0.000000000000".into());
    let unlocked = model
        .unlocked
        .clone()
        .unwrap_or_else(|| "0.000000000000".into());
    let address = shorten(&model.address.clone().unwrap_or_default());
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(8),
            Constraint::Length(12),
            Constraint::Min(4),
        ])
        .split(area);

    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(ORANGE))
            .style(Style::default().bg(CARD)),
        rows[0],
    );
    let left = shrink(rows[0], 2, 1, 2, 1);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled("BALANCE", Style::default().fg(MUTED))),
            Line::from(Span::styled(
                format!("{balance}  XMR"),
                Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                format!("Unlocked  {unlocked} XMR"),
                Style::default().fg(MUTED),
            )),
            Line::from(Span::styled(
                format!("Receive    {address}"),
                Style::default().fg(ORANGE_SOFT),
            )),
            Line::from(Span::styled(
                if model.hardware {
                    "Ledger Nano · seed stays on the device"
                } else {
                    "Software wallet"
                },
                Style::default().fg(MUTED),
            )),
        ]),
        left,
    );
    draw_chip(
        app,
        frame,
        left.x.saturating_add(left.width.saturating_sub(22)),
        left.y + 1,
        "Receive",
        Action::GoTab(Tab::Receive),
        false,
    );
    draw_chip(
        app,
        frame,
        left.x.saturating_add(left.width.saturating_sub(10)),
        left.y + 1,
        "Send",
        Action::GoTab(Tab::Send),
        true,
    );

    draw_sync_card(app, frame, rows[1]);
    let activity = rows[2];
    if activity.height > 3 {
        frame.render_widget(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(CARD_EDGE))
                .style(Style::default().bg(CARD))
                .title(Span::styled(
                    "  recent activity  ",
                    Style::default().fg(MUTED),
                )),
            activity,
        );
        let lines: Vec<Line> = if model.transactions.is_empty() {
            vec![Line::from(Span::styled(
                "  No transactions yet.",
                Style::default().fg(MUTED),
            ))]
        } else {
            model
                .transactions
                .iter()
                .take(6)
                .map(|item| {
                    Line::from(Span::styled(format!("  {item}"), Style::default().fg(TEXT)))
                })
                .collect()
        };
        frame.render_widget(Paragraph::new(lines), shrink(activity, 1, 1, 1, 1));
        app.hits.push(Hit {
            x: activity.x,
            y: activity.y,
            width: activity.width,
            height: activity.height,
            action: Action::GoTab(Tab::Activity),
        });
    }
}

fn draw_sync_card(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let sync = app.view_model().sync;
    let led = if sync.ready {
        OK
    } else if sync.failed {
        DANGER
    } else {
        AMBER
    };
    let border = if sync.ready {
        Color::Rgb(49, 90, 77)
    } else {
        CARD_EDGE
    };
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(border))
            .style(Style::default().bg(CARD)),
        area,
    );
    let inner = shrink(area, 2, 1, 3, 1);
    let status_color = if sync.ready {
        OK
    } else if sync.failed {
        DANGER
    } else {
        AMBER
    };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("●  ", Style::default().fg(led)),
            Span::styled(
                sync.compact.clone(),
                Style::default()
                    .fg(status_color)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                if sync.failed {
                    format!("    {}", app.view_model().settings.cli_daemon)
                } else {
                    "    ↻ refresh".into()
                },
                Style::default().fg(MUTED),
            ),
        ])),
        Rect {
            x: inner.x,
            y: inner.y,
            width: inner.width,
            height: 1,
        },
    );
    app.hits.push(Hit {
        x: inner.x.saturating_add(inner.width.saturating_sub(12)),
        y: inner.y,
        width: 12,
        height: 1,
        action: Action::Refresh,
    });
    if sync.failed {
        app.hits.push(Hit {
            x: inner.x,
            y: inner.y,
            width: inner.width.saturating_sub(12),
            height: 1,
            action: Action::OpenMenu(crate::settings::MenuItem::Node),
        });
    }

    draw_sync_row(
        frame,
        inner.x,
        inner.y + 2,
        inner.width,
        "Blockchain data",
        &sync.blockchain_detail,
        sync.blockchain_percent,
        sync.blockchain_height.as_deref(),
        None,
        sync.ready,
    );
    draw_sync_row(
        frame,
        inner.x,
        inner.y + 6,
        inner.width,
        "Wallet scan",
        &sync.phase,
        sync.percent,
        sync.height.as_deref(),
        sync.eta.as_deref().or(sync.remaining.as_deref()),
        sync.ready,
    );
}

#[allow(clippy::too_many_arguments)]
fn draw_sync_row(
    frame: &mut Frame<'_>,
    x: u16,
    y: u16,
    width: u16,
    label: &str,
    detail: &str,
    percent: Option<u8>,
    height: Option<&str>,
    extra: Option<&str>,
    ready: bool,
) {
    let percent_text = percent
        .map(|value| format!("{value}%"))
        .unwrap_or_else(|| "—".into());
    let percent_color = if percent == Some(100) || ready {
        OK
    } else {
        AMBER
    };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                format!("{label:<18}"),
                Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("{detail:<28}"), Style::default().fg(MUTED)),
            Span::styled(
                format!("{percent_text:>4}"),
                Style::default()
                    .fg(percent_color)
                    .add_modifier(Modifier::BOLD),
            ),
        ])),
        Rect {
            x,
            y,
            width,
            height: 1,
        },
    );
    let ratio = f64::from(percent.unwrap_or(0)) / 100.0;
    frame.render_widget(
        Gauge::default()
            .gauge_style(Style::default().fg(percent_color).bg(TRACK))
            .ratio(ratio)
            .label(""),
        Rect {
            x,
            y: y + 1,
            width,
            height: 1,
        },
    );
    let metric = [height, extra]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("   ");
    if !metric.is_empty() {
        frame.render_widget(
            Paragraph::new(Span::styled(metric, Style::default().fg(MUTED))),
            Rect {
                x,
                y: y + 2,
                width,
                height: 1,
            },
        );
    }
}

fn draw_receive(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let model = app.view_model();
    let address = model.address.clone().unwrap_or_default();
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(28), Constraint::Min(30)])
        .split(area);

    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(CARD_EDGE))
            .style(Style::default().bg(Color::Rgb(255, 255, 255)))
            .title(Span::styled(" QR ", Style::default().fg(ORANGE))),
        columns[0],
    );
    if !address.is_empty() {
        let qr = render_qr(&address);
        frame.render_widget(
            Paragraph::new(qr).style(
                Style::default()
                    .fg(Color::Rgb(8, 7, 13))
                    .bg(Color::Rgb(255, 255, 255)),
            ),
            shrink(columns[0], 1, 1, 1, 1),
        );
    }

    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(CARD_EDGE))
            .style(Style::default().bg(CARD))
            .title(Span::styled("  receive  ", Style::default().fg(ORANGE))),
        columns[1],
    );
    let inner = shrink(columns[1], 2, 1, 2, 1);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled("Selected address", Style::default().fg(MUTED))),
            Line::from(""),
            Line::from(Span::styled(
                shorten(&address),
                Style::default()
                    .fg(ORANGE_SOFT)
                    .add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
            Line::from(Span::styled(&address, Style::default().fg(MUTED))),
            Line::from(""),
            Line::from(Span::styled(
                "Share QR or address only with the intended sender.",
                Style::default().fg(MUTED),
            )),
        ])
        .wrap(Wrap { trim: true }),
        inner,
    );
    draw_primary(
        app,
        frame,
        inner.x,
        inner.y.saturating_add(inner.height.saturating_sub(3)),
        "New subaddress",
        Action::NewSubaddress,
    );
}

fn draw_send(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let model = app.view_model();
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(if model.review.is_some() {
                ORANGE
            } else {
                CARD_EDGE
            }))
            .style(Style::default().bg(CARD))
            .title(Span::styled(
                if model.review.is_some() {
                    "  review payment  "
                } else {
                    "  send Monero  "
                },
                Style::default().fg(ORANGE),
            )),
        area,
    );
    let inner = shrink(area, 2, 1, 3, 2);
    let mut y = inner.y;
    y = draw_input(
        app,
        frame,
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 4,
        },
        "To",
        &field_value(&model.recipient, model.focused == Field::Address),
        Field::Address,
    );
    y = draw_input(
        app,
        frame,
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: 4,
        },
        "Amount  XMR",
        &field_value(&model.amount, model.focused == Field::Amount),
        Field::Amount,
    );
    if let Some(review) = &model.review {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "Nothing has been broadcast",
                    Style::default().fg(DANGER).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    format!("Destination  {}", review.address),
                    Style::default().fg(ORANGE_SOFT),
                )),
                Line::from(Span::styled(
                    format!("Amount       {} XMR", review.amount),
                    Style::default().fg(TEXT),
                )),
                Line::from(Span::styled(
                    format!("Fee          {} XMR", review.fee),
                    Style::default().fg(MUTED),
                )),
            ]),
            Rect {
                x: inner.x,
                y,
                width: inner.width,
                height: 5,
            },
        );
        draw_primary(
            app,
            frame,
            inner.x,
            inner.y.saturating_add(inner.height.saturating_sub(2)),
            "Confirm and submit",
            Action::ConfirmSend,
        );
        draw_chip(
            app,
            frame,
            inner.x + 24,
            inner.y.saturating_add(inner.height.saturating_sub(2)),
            "Cancel payment",
            Action::CancelSend,
            false,
        );
    } else {
        frame.render_widget(
            Paragraph::new(Span::styled(
                if model.hardware {
                    "Keep the Ledger unlocked and confirm the transaction on its display. Review is mandatory before broadcast."
                } else {
                    "Recipient first, then amount. Review is mandatory before broadcast."
                },
                Style::default().fg(MUTED),
            )),
            Rect {
                x: inner.x,
                y,
                width: inner.width,
                height: 2,
            },
        );
        draw_primary(
            app,
            frame,
            inner.x,
            inner.y.saturating_add(inner.height.saturating_sub(2)),
            "Review payment",
            Action::ReviewSend,
        );
    }
}

fn draw_activity(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let model = app.view_model();
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(CARD_EDGE))
            .style(Style::default().bg(CARD))
            .title(Span::styled("  activity  ", Style::default().fg(ORANGE))),
        area,
    );
    let lines: Vec<Line> = if model.transactions.is_empty() {
        vec![Line::from(Span::styled(
            "No transactions yet.",
            Style::default().fg(MUTED),
        ))]
    } else {
        model
            .transactions
            .iter()
            .map(|item| Line::from(Span::styled(item.clone(), Style::default().fg(TEXT))))
            .collect()
    };
    frame.render_widget(Paragraph::new(lines), shrink(area, 2, 1, 2, 1));
}

fn draw_help(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(CARD_EDGE))
            .style(Style::default().bg(CARD))
            .title(Span::styled("  help  ", Style::default().fg(ORANGE))),
        area,
    );
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                "Same layout as the desktop wallet.",
                Style::default().fg(TEXT),
            )),
            Line::from(""),
            Line::from(Span::styled("Sidebar", Style::default().fg(ORANGE))),
            Line::from("  Home · Send · Receive · Menu"),
            Line::from("  Menu: Wallets · .mfw names · Settings · Node"),
            Line::from(""),
            Line::from(Span::styled("Keyboard", Style::default().fg(ORANGE))),
            Line::from("  Tab  next screen     /  command bar     q  quit"),
            Line::from("  b    balance         a  receive         r  refresh"),
            Line::from("  send <addr> <xmr>    review still required"),
            Line::from(""),
            Line::from(Span::styled("Safety", Style::default().fg(ORANGE))),
            Line::from("  Seeds never become CLI arguments. Spend always has a review step."),
            Line::from(
                "  Ledger Nano: USB or Bluetooth, scan height required, seed stays on device.",
            ),
        ]),
        shrink(area, 2, 1, 2, 1),
    );
    let _ = app;
}

fn draw_menu(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let model = app.view_model();
    let address = model
        .address
        .as_deref()
        .map(shorten)
        .unwrap_or_else(|| "Open wallet".into());
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                model
                    .wallet_path
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or("Menu"),
                Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(address, Style::default().fg(MUTED))),
        ]),
        Rect {
            x: area.x,
            y: area.y,
            width: area.width,
            height: 2,
        },
    );
    let mut y = area.y + 3;
    for item in model.menu_items {
        if y.saturating_add(3) > area.y.saturating_add(area.height) {
            break;
        }
        let card = Rect {
            x: area.x,
            y,
            width: area.width.min(72),
            height: 3,
        };
        frame.render_widget(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(CARD_EDGE))
                .style(Style::default().bg(CARD)),
            card,
        );
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    item.title,
                    Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(item.hint, Style::default().fg(MUTED))),
            ]),
            shrink(card, 1, 0, 2, 0),
        );
        app.hits.push(Hit {
            x: card.x,
            y: card.y,
            width: card.width,
            height: card.height,
            action: Action::OpenMenu(item.item),
        });
        y = y.saturating_add(4);
    }
    if y + 1 < area.y.saturating_add(area.height) {
        frame.render_widget(
            Paragraph::new(Span::styled(
                "Developed with ♥ by TEX8",
                Style::default().fg(MUTED),
            )),
            Rect {
                x: area.x,
                y: area.y.saturating_add(area.height.saturating_sub(1)),
                width: area.width,
                height: 1,
            },
        );
    }
}

fn slot(area: Rect, scroll: u16, y: u16, height: u16) -> Option<Rect> {
    if y < scroll {
        return None;
    }
    let rel = y - scroll;
    if rel >= area.height {
        return None;
    }
    Some(Rect {
        x: area.x,
        y: area.y + rel,
        width: area.width,
        height: height.min(area.height.saturating_sub(rel)),
    })
}

fn draw_settings(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let model = app.view_model();
    let settings = model.settings.clone();
    let hardware = model.hardware;
    let wallet_open = model.wallet_open;
    let wallet_label = if wallet_open {
        format!(
            "{} · {}",
            model
                .wallet_path
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("wallet"),
            model.network
        )
    } else {
        "No wallet open".into()
    };
    let seed_text = app.revealed_seed().map(ToOwned::to_owned);
    let scroll = settings.scroll;
    let mut y = 0u16;

    if let Some(rect) = slot(area, scroll, y, 3) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "Settings",
                    Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "Only the choices that change how this local wallet works.",
                    Style::default().fg(MUTED),
                )),
            ]),
            rect,
        );
    }
    y += 3;

    y = draw_settings_section(
        app,
        frame,
        area,
        scroll,
        y,
        "Fast Wallet Worker",
        settings.worker_label.as_str(),
    );
    if let Some(rect) = slot(area, scroll, y, 4) {
        draw_choice_card(
            app,
            frame,
            rect,
            "Recommended",
            "Use the signed TEX8 Worker configured in this app.",
            settings.worker == WorkerKind::Recommended,
            Action::Settings(SettingsAction::ChooseRecommendedWorker),
        );
    }
    y += 5;
    if PRIVATE_WORKER_PAIRING {
        if let Some(rect) = slot(area, scroll, y, 3) {
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(Span::styled(
                        "Approved Community Workers",
                        Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                    )),
                    Line::from(Span::styled(
                        "Only Workers approved in the signed public directory are shown.",
                        Style::default().fg(MUTED),
                    )),
                ]),
                rect,
            );
        }
        y += 3;
        if let Some(rect) = slot(area, scroll, y, 2) {
            frame.render_widget(
                Paragraph::new(Span::styled(
                    "The Worker directory is temporarily unavailable. Your current choice remains active.",
                    Style::default().fg(AMBER),
                )),
                rect,
            );
        }
        y += 2;
        if let Some(rect) = slot(area, scroll, y, 4) {
            draw_choice_card(
                app,
                frame,
                rect,
                "Private Worker",
                "Advanced: pair your own Worker from its signed QR code or descriptor.",
                settings.worker == WorkerKind::Private,
                Action::Settings(SettingsAction::TogglePrivateWorker),
            );
        }
        y += 5;
        if settings.show_private_worker {
            if let Some(rect) = slot(area, scroll, y, 5) {
                draw_input(
                    app,
                    frame,
                    rect,
                    "Paste Worker QR text or descriptor",
                    &settings.private_worker,
                    Field::PrivateWorker,
                );
                draw_chip(
                    app,
                    frame,
                    rect.x,
                    rect.y.saturating_add(rect.height.saturating_sub(1)),
                    "Use this Worker",
                    Action::Settings(SettingsAction::UsePrivateWorker),
                    true,
                );
            }
            y += 6;
        }
    }

    y = draw_settings_section(
        app,
        frame,
        area,
        scroll,
        y,
        "Project Page",
        "Clearnet · Onion",
    );
    if let Some(rect) = slot(area, scroll, y, 6) {
        frame.render_widget(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(CARD_EDGE))
                .style(Style::default().bg(CARD)),
            rect,
        );
        let mut lines = vec![
            Line::from(Span::styled(
                "Project Page",
                Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                "Official Clearnet and Onion addresses, services, and self-hosting.",
                Style::default().fg(MUTED),
            )),
        ];
        for address in PROJECT_ADDRESSES {
            lines.push(Line::from(Span::styled(
                format!("  {} · {}", address.transport, address.address),
                Style::default().fg(ORANGE_SOFT),
            )));
        }
        frame.render_widget(Paragraph::new(lines), shrink(rect, 1, 0, 2, 0));
        draw_chip(
            app,
            frame,
            rect.x.saturating_add(rect.width.saturating_sub(10)),
            rect.y + 1,
            "Open",
            Action::Settings(SettingsAction::OpenProject),
            true,
        );
    }
    y += 7;

    y = draw_settings_section(app, frame, area, scroll, y, "Monero Name Registry", ".mfw");
    if let Some(rect) = slot(area, scroll, y, 4) {
        draw_choice_card(
            app,
            frame,
            rect,
            "Monero Name Registry",
            "Register and manage a simple public .mfw name for a receive address.",
            false,
            Action::Settings(SettingsAction::OpenMfwRegistry),
        );
        draw_chip(
            app,
            frame,
            rect.x.saturating_add(rect.width.saturating_sub(22)),
            rect.y + 1,
            "Open name registry",
            Action::Settings(SettingsAction::OpenMfwRegistry),
            false,
        );
    }
    y += 5;

    y = draw_settings_section(
        app,
        frame,
        area,
        scroll,
        y,
        "Language",
        "Used only in this desktop app.",
    );
    if let Some(rect) = slot(area, scroll, y, 3) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    format!("Language  {}", settings.language_name),
                    Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    LANGUAGES
                        .iter()
                        .map(|item| item.code)
                        .collect::<Vec<_>>()
                        .join(" · "),
                    Style::default().fg(MUTED),
                )),
            ]),
            rect,
        );
        draw_chip(
            app,
            frame,
            rect.x.saturating_add(rect.width.saturating_sub(12)),
            rect.y,
            "Change",
            Action::Settings(SettingsAction::CycleLanguage),
            true,
        );
    }
    y += 4;

    y = draw_settings_section(
        app,
        frame,
        area,
        scroll,
        y,
        "Performance",
        if ComputeBackend::Metal.available() || ComputeBackend::Cuda.available() {
            "Verified GPU ready"
        } else {
            "CPU ready"
        },
    );
    if let Some(rect) = slot(area, scroll, y, 5) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "Wallet scanning",
                    Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "CPU remains the safe fallback if Metal or CUDA is unavailable.",
                    Style::default().fg(MUTED),
                )),
            ]),
            rect,
        );
        let mut x = rect.x;
        for backend in [
            ComputeBackend::Cpu,
            ComputeBackend::Metal,
            ComputeBackend::Cuda,
        ] {
            draw_chip(
                app,
                frame,
                x,
                rect.y + 3,
                backend.label(),
                Action::Settings(SettingsAction::SetCompute(backend)),
                settings.compute == backend,
            );
            x = x.saturating_add(backend.label().len() as u16 + 4);
        }
    }
    y += 6;
    if let Some(rect) = slot(area, scroll, y, 4) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "Scan performance",
                    Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "A short one-time device test using public sample data.",
                    Style::default().fg(MUTED),
                )),
                Line::from(Span::styled(
                    format!(
                        "CPU  {}    Metal  {}    CUDA  {}",
                        if ComputeBackend::Cpu.available() {
                            "ready"
                        } else {
                            "Not available"
                        },
                        if ComputeBackend::Metal.available() {
                            "ready"
                        } else {
                            "Not available"
                        },
                        if ComputeBackend::Cuda.available() {
                            "ready"
                        } else {
                            "Not available"
                        }
                    ),
                    Style::default().fg(ORANGE_SOFT),
                )),
            ]),
            rect,
        );
    }
    y += 5;

    y = draw_settings_section(
        app,
        frame,
        area,
        scroll,
        y,
        "Community privacy",
        if settings.share_searches {
            "Ready"
        } else {
            "Off"
        },
    );
    if let Some(rect) = slot(area, scroll, y, 4) {
        draw_choice_card(
            app,
            frame,
            rect,
            "Help improve search suggestions",
            "On by default. Completed Community searches may be sent without wallet data.",
            settings.share_searches,
            Action::Settings(SettingsAction::ToggleShareSearches),
        );
    }
    y += 5;

    y = draw_settings_section(app, frame, area, scroll, y, "Wallet", &wallet_label);
    if let Some(rect) = slot(area, scroll, y, 4) {
        draw_choice_card(
            app,
            frame,
            rect,
            "Recovery seed",
            if hardware {
                "The recovery seed remains on the Ledger device."
            } else {
                "Show it only when you need to verify your backup."
            },
            false,
            Action::Settings(SettingsAction::RevealSeed),
        );
        draw_chip(
            app,
            frame,
            rect.x.saturating_add(rect.width.saturating_sub(22)),
            rect.y + 1,
            "Show recovery seed",
            Action::Settings(SettingsAction::RevealSeed),
            true,
        );
    }
    y += 5;
    if let Some(seed) = seed_text {
        let height = 4;
        if let Some(rect) = slot(area, scroll, y, height) {
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(Span::styled(
                        "Recovery seed  ·  write it down offline",
                        Style::default().fg(ORANGE),
                    )),
                    Line::from(Span::styled(seed, Style::default().fg(TEXT))),
                ])
                .wrap(Wrap { trim: true }),
                rect,
            );
        }
        y += 5;
    }
    if hardware {
        if let Some(rect) = slot(area, scroll, y, 4) {
            draw_choice_card(
                app,
                frame,
                rect,
                "Recheck with Ledger",
                "Use this after spending from another device.",
                false,
                Action::Settings(SettingsAction::RecheckLedger),
            );
        }
        y += 5;
    }
    if let Some(rect) = slot(area, scroll, y, 3) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "App protection",
                    Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "Unlock the app once, then select saved wallets without separate password prompts.",
                    Style::default().fg(MUTED),
                )),
            ]),
            rect,
        );
        draw_chip(
            app,
            frame,
            rect.x.saturating_add(rect.width.saturating_sub(16)),
            rect.y,
            "Secure storage",
            Action::Settings(SettingsAction::LockNow),
            false,
        );
    }
    y += 4;

    y = draw_settings_section(app, frame, area, scroll, y, "Security", "Local device");
    if let Some(rect) = slot(area, scroll, y, 3) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "App lock",
                    Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "Choose one secure way to unlock this app before selecting saved wallets.",
                    Style::default().fg(MUTED),
                )),
            ]),
            rect,
        );
        draw_chip(
            app,
            frame,
            rect.x.saturating_add(rect.width.saturating_sub(16)),
            rect.y,
            "Lock app now",
            Action::Settings(SettingsAction::LockNow),
            settings.protection != ProtectionMode::None,
        );
    }
    y += 3;
    if settings.protection == ProtectionMode::None {
        if let Some(rect) = slot(area, scroll, y, 1) {
            frame.render_widget(
                Paragraph::new(Span::styled(
                    "No app protection is active. Choose a method below to enable it.",
                    Style::default().fg(AMBER),
                )),
                rect,
            );
        }
        y += 2;
    }
    if let Some(rect) = slot(area, scroll, y, 3) {
        draw_chip(
            app,
            frame,
            rect.x,
            rect.y,
            &settings.system_auth,
            Action::Settings(SettingsAction::SetProtection(ProtectionMode::System)),
            settings.protection == ProtectionMode::System,
        );
        draw_chip(
            app,
            frame,
            rect.x.saturating_add(18),
            rect.y,
            "App password",
            Action::Settings(SettingsAction::SetProtection(ProtectionMode::Password)),
            settings.protection == ProtectionMode::Password,
        );
        frame.render_widget(
            Paragraph::new(Span::styled(
                if settings.protection == ProtectionMode::System {
                    format!(
                        "{} uses your computer sign-in as backup. No extra app password is needed.",
                        settings.system_auth
                    )
                } else {
                    "This password is used only for Monero Fast Wallet.".into()
                },
                Style::default().fg(MUTED),
            )),
            Rect {
                x: rect.x,
                y: rect.y + 1,
                width: rect.width,
                height: 2,
            },
        );
    }
    y += 4;
    if settings.protection == ProtectionMode::Password {
        if let Some(rect) = slot(area, scroll, y, 8) {
            let masked: String = "•".repeat(settings.app_password_len);
            let confirm: String = "•".repeat(settings.app_password_confirm_len);
            let current: String = "•".repeat(settings.current_app_password_len);
            draw_input(
                app,
                frame,
                Rect {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width / 2,
                    height: 4,
                },
                "New app password (at least 12 characters)",
                &masked,
                Field::AppPassword,
            );
            draw_input(
                app,
                frame,
                Rect {
                    x: rect.x + rect.width / 2,
                    y: rect.y,
                    width: rect.width / 2,
                    height: 4,
                },
                "Confirm password",
                &confirm,
                Field::AppPasswordConfirm,
            );
            draw_input(
                app,
                frame,
                Rect {
                    x: rect.x,
                    y: rect.y + 4,
                    width: rect.width / 2,
                    height: 4,
                },
                "Current app password",
                &current,
                Field::CurrentAppPassword,
            );
            draw_chip(
                app,
                frame,
                rect.x + rect.width / 2,
                rect.y + 5,
                "Set app password",
                Action::Settings(SettingsAction::SaveProtection),
                true,
            );
        }
        y += 9;
    }
    if let Some(rect) = slot(area, scroll, y, 3) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "Automatic app lock",
                    Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    if settings.protection == ProtectionMode::None {
                        "Enable app protection first to use automatic locking.".to_owned()
                    } else {
                        format!("Timeout: {}", settings.auto_lock_label)
                    },
                    Style::default().fg(MUTED),
                )),
            ]),
            rect,
        );
        draw_chip(
            app,
            frame,
            rect.x.saturating_add(rect.width.saturating_sub(18)),
            rect.y,
            settings.auto_lock_label.as_str(),
            Action::Settings(SettingsAction::CycleAutoLock),
            false,
        );
    }
    y += 4;
    if let Some(rect) = slot(area, scroll, y, 1) {
        frame.render_widget(
            Paragraph::new(Span::styled(
                AUTO_LOCK_OPTIONS
                    .iter()
                    .map(|(_, label)| *label)
                    .collect::<Vec<_>>()
                    .join(" · "),
                Style::default().fg(MUTED),
            )),
            rect,
        );
    }
    y += 2;

    y = draw_settings_section(app, frame, area, scroll, y, "About", "Local desktop wallet");
    if let Some(rect) = slot(area, scroll, y, 5) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "Privacy by design",
                    Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "Wallet keys, recovery seeds, and Ledger signing remain in the native Monero core.",
                    Style::default().fg(MUTED),
                )),
                Line::from(Span::styled(
                    "Market display",
                    Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "Dashboard values use XMR/USD, matching the mobile wallet.",
                    Style::default().fg(MUTED),
                )),
            ])
            .wrap(Wrap { trim: true }),
            rect,
        );
    }
    y += 6;

    if let Some(rect) = slot(area, scroll, y, 1) {
        frame.render_widget(
            Paragraph::new(Span::styled(
                "PgUp / PgDn  scroll   Esc  back to Menu",
                Style::default().fg(MUTED),
            )),
            rect,
        );
    }
}

fn draw_settings_section(
    _app: &mut App,
    frame: &mut Frame<'_>,
    area: Rect,
    scroll: u16,
    y: u16,
    title: &str,
    hint: &str,
) -> u16 {
    if let Some(rect) = slot(area, scroll, y, 2) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    title,
                    Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(hint, Style::default().fg(MUTED))),
            ]),
            rect,
        );
    }
    y + 2
}

fn draw_choice_card(
    app: &mut App,
    frame: &mut Frame<'_>,
    area: Rect,
    title: &str,
    hint: &str,
    selected: bool,
    action: Action,
) {
    let Some(area) = clamp_to_frame(frame, area.x, area.y, area.width, area.height) else {
        return;
    };
    let border = if selected { ORANGE } else { CARD_EDGE };
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(border))
            .style(Style::default().bg(if selected { ORANGE_DIM } else { CARD })),
        area,
    );
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                format!("{}{}", if selected { "✓  " } else { "   " }, title),
                Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(hint, Style::default().fg(MUTED))),
        ]),
        shrink(area, 1, 0, 2, 0),
    );
    app.hits.push(Hit {
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
        action,
    });
}

fn draw_wallets(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let model = app.view_model();
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                "Saved wallets",
                Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                "Manage and rename local wallets.",
                Style::default().fg(MUTED),
            )),
        ]),
        Rect {
            x: area.x,
            y: area.y,
            width: area.width,
            height: 2,
        },
    );
    draw_chip(
        app,
        frame,
        area.x.saturating_add(area.width.saturating_sub(16)),
        area.y,
        "Add wallet",
        Action::SelectCreate,
        true,
    );
    let mut y = area.y + 3;
    if model.known_wallets.is_empty() {
        frame.render_widget(
            Paragraph::new(Span::styled(
                "No wallets in the desktop folder yet.",
                Style::default().fg(MUTED),
            )),
            Rect {
                x: area.x,
                y,
                width: area.width,
                height: 1,
            },
        );
        return;
    }
    for wallet in model.known_wallets {
        if y.saturating_add(3) > area.y.saturating_add(area.height) {
            break;
        }
        let card = Rect {
            x: area.x,
            y,
            width: area.width.min(72),
            height: 3,
        };
        frame.render_widget(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(CARD_EDGE))
                .style(Style::default().bg(CARD)),
            card,
        );
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    wallet.label,
                    Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(wallet.detail, Style::default().fg(MUTED))),
            ]),
            shrink(card, 1, 0, 2, 0),
        );
        app.hits.push(Hit {
            x: card.x,
            y: card.y,
            width: card.width,
            height: card.height,
            action: Action::SetWalletPath(wallet.path),
        });
        y = y.saturating_add(4);
    }
}

fn draw_node(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let settings = app.view_model().settings;
    let scroll = settings.scroll;
    let mut y = 0u16;
    if let Some(rect) = slot(area, scroll, y, 3) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "Node Status",
                    Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "Desktop uses gRPC + Onion/Tor. The TUI CLI uses Clearnet JSON-RPC on port 18089.",
                    Style::default().fg(MUTED),
                )),
            ])
            .wrap(Wrap { trim: true }),
            rect,
        );
    }
    y += 3;
    let probe_lines = if settings.node_checking {
        vec![Line::from(Span::styled(
            "Checking DNS, Tor, daemon RPC and gRPC…",
            Style::default().fg(AMBER),
        ))]
    } else if settings.node_probes.is_empty() {
        vec![
            Line::from(Span::styled("Not checked yet.", Style::default().fg(MUTED))),
            Line::from(Span::styled(
                format!("Daemon  {}", settings.daemon_address),
                Style::default().fg(ORANGE_SOFT),
            )),
            Line::from(Span::styled(
                format!("gRPC    {}", settings.grpc_endpoint),
                Style::default().fg(ORANGE_SOFT),
            )),
        ]
    } else {
        settings
            .node_probes
            .iter()
            .map(|probe| {
                let color = if probe.connected { OK } else { DANGER };
                let mark = if probe.connected { "●" } else { "○" };
                Line::from(vec![
                    Span::styled(format!("{mark} "), Style::default().fg(color)),
                    Span::styled(
                        format!("{}  ", probe.label),
                        Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!("{}  {}", probe.detail, probe.endpoint),
                        Style::default().fg(if probe.connected { OK } else { MUTED }),
                    ),
                ])
            })
            .collect()
    };
    let probe_height = (probe_lines.len() as u16).saturating_add(3).max(6);
    if let Some(rect) = slot(area, scroll, y, probe_height) {
        frame.render_widget(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(CARD_EDGE))
                .style(Style::default().bg(CARD))
                .title(Span::styled(
                    "  connection check  ",
                    Style::default().fg(ORANGE),
                )),
            rect,
        );
        frame.render_widget(Paragraph::new(probe_lines), shrink(rect, 1, 1, 2, 1));
        draw_chip(
            app,
            frame,
            rect.x + 2,
            rect.y.saturating_add(rect.height.saturating_sub(2)),
            if settings.node_checking {
                "Checking…"
            } else {
                "Check both connections"
            },
            Action::Settings(SettingsAction::RunDiagnostics),
            true,
        );
    }
    y = y.saturating_add(probe_height.saturating_add(1));
    if let Some(rect) = slot(area, scroll, y, 2) {
        frame.render_widget(
            Paragraph::new(Span::styled(
                format!("Network  {}", settings.node_network),
                Style::default().fg(TEXT),
            )),
            rect,
        );
        draw_chip(
            app,
            frame,
            rect.x.saturating_add(18),
            rect.y,
            "Cycle",
            Action::Settings(SettingsAction::CycleNodeNetwork),
            false,
        );
    }
    y += 2;
    if let Some(rect) = slot(area, scroll, y, 2) {
        let mut x = rect.x;
        for mode in [
            NodeMode::OptimizedGrpc,
            NodeMode::OriginalRpc,
            NodeMode::Custom,
        ] {
            draw_chip(
                app,
                frame,
                x,
                rect.y,
                mode.label(),
                Action::Settings(SettingsAction::SetNodeMode(mode)),
                settings.node_mode == mode,
            );
            x = x.saturating_add(mode.label().len() as u16 + 4);
        }
    }
    y += 3;
    if settings.node_mode == NodeMode::OptimizedGrpc {
        if let Some(rect) = slot(area, scroll, y, 2) {
            frame.render_widget(
                Paragraph::new(Span::styled(
                    "Blockchain sync · Clearnet",
                    Style::default().fg(ORANGE),
                )),
                rect,
            );
        }
        y += 2;
        if let Some(rect) = slot(area, scroll, y, 3) {
            draw_choice_card(
                app,
                frame,
                Rect {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width.min(36),
                    height: 3,
                },
                "TEX8 Node",
                &NodePreset::Tex8.grpc(),
                settings.grpc_endpoint == NodePreset::Tex8.grpc(),
                Action::Settings(SettingsAction::ChooseClearnet(NodePreset::Tex8)),
            );
            draw_choice_card(
                app,
                frame,
                Rect {
                    x: rect.x.saturating_add(38),
                    y: rect.y,
                    width: rect.width.saturating_sub(38).min(36),
                    height: 3,
                },
                "Community Node",
                &NodePreset::Community.grpc(),
                settings.grpc_endpoint == NodePreset::Community.grpc(),
                Action::Settings(SettingsAction::ChooseClearnet(NodePreset::Community)),
            );
        }
        y += 4;
        if let Some(rect) = slot(area, scroll, y, 4) {
            draw_input(
                app,
                frame,
                rect,
                "Clearnet gRPC endpoint",
                &settings.grpc_endpoint,
                Field::NodeGrpc,
            );
        }
        y += 5;
        if let Some(rect) = slot(area, scroll, y, 2) {
            frame.render_widget(
                Paragraph::new(Span::styled(
                    "Wallet operations · Tor",
                    Style::default().fg(ORANGE),
                )),
                rect,
            );
        }
        y += 2;
        if let Some(rect) = slot(area, scroll, y, 3) {
            draw_choice_card(
                app,
                frame,
                Rect {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width.min(36),
                    height: 3,
                },
                "TEX8 Node",
                &NodePreset::Tex8.onion_daemon(),
                settings.daemon_address == NodePreset::Tex8.onion_daemon(),
                Action::Settings(SettingsAction::ChooseOnion(NodePreset::Tex8)),
            );
            draw_choice_card(
                app,
                frame,
                Rect {
                    x: rect.x.saturating_add(38),
                    y: rect.y,
                    width: rect.width.saturating_sub(38).min(36),
                    height: 3,
                },
                "Community Node",
                &NodePreset::Community.onion_daemon(),
                settings.daemon_address == NodePreset::Community.onion_daemon(),
                Action::Settings(SettingsAction::ChooseOnion(NodePreset::Community)),
            );
        }
        y += 4;
        if let Some(rect) = slot(area, scroll, y, 4) {
            draw_input(
                app,
                frame,
                rect,
                "Daemon endpoint",
                &settings.daemon_address,
                Field::NodeDaemon,
            );
        }
        y += 5;
    } else if let Some(rect) = slot(area, scroll, y, 8) {
        draw_input(
            app,
            frame,
            Rect {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: 4,
            },
            "Monero daemon RPC",
            &settings.daemon_address,
            Field::NodeDaemon,
        );
        draw_input(
            app,
            frame,
            Rect {
                x: rect.x,
                y: rect.y + 4,
                width: rect.width,
                height: 4,
            },
            "SOCKS5 proxy  Optional for Onion",
            &settings.proxy_address,
            Field::NodeProxy,
        );
        y += 9;
    }
    if let Some(rect) = slot(area, scroll, y, 1) {
        draw_chip(
            app,
            frame,
            rect.x,
            rect.y,
            "Reset defaults",
            Action::Settings(SettingsAction::ResetNodeDefaults),
            false,
        );
    }
}

fn draw_mfw(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let settings = app.view_model().settings;
    let address = app.view_model().address.clone().unwrap_or_default();
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                "Your Address Names",
                Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                "Claim a memorable public .mfw name for a Monero receive address.",
                Style::default().fg(MUTED),
            )),
            Line::from(Span::styled(
                "Registry  49indexName…  ·  .mfw",
                Style::default().fg(ORANGE_SOFT),
            )),
        ]),
        Rect {
            x: area.x,
            y: area.y,
            width: area.width,
            height: 3,
        },
    );
    draw_input(
        app,
        frame,
        Rect {
            x: area.x,
            y: area.y + 4,
            width: area.width.min(48),
            height: 4,
        },
        "Name  (without .mfw)",
        &settings.mfw_name,
        Field::MfwName,
    );
    draw_chip(
        app,
        frame,
        area.x.saturating_add(50),
        area.y + 6,
        if settings.mfw_checking {
            "Checking…"
        } else {
            "Check name"
        },
        Action::Settings(SettingsAction::CheckMfwName),
        true,
    );
    let status_color = if settings.mfw_available {
        OK
    } else if settings.mfw_checking {
        AMBER
    } else {
        MUTED
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                format!("Term  {} year(s)", settings.mfw_years),
                Style::default().fg(TEXT),
            )),
            Line::from(Span::styled(
                format!("Receive address  {}", shorten(&address)),
                Style::default().fg(MUTED),
            )),
            Line::from(""),
            Line::from(Span::styled(
                format!(
                    "Step {} of 3   1 Choose name   2 Confirm term   3 Commit on-chain",
                    settings.mfw_step
                ),
                Style::default().fg(ORANGE),
            )),
            Line::from(Span::styled(&settings.mfw_status, Style::default().fg(status_color))),
            Line::from(Span::styled(
                "No names registered on this device yet.",
                Style::default().fg(MUTED),
            )),
        ]),
        Rect {
            x: area.x,
            y: area.y + 9,
            width: area.width,
            height: 7,
        },
    );
    draw_chip(
        app,
        frame,
        area.x,
        area.y + 8,
        "Term +",
        Action::Settings(SettingsAction::CycleMfwYears),
        false,
    );
    draw_chip(
        app,
        frame,
        area.x + 12,
        area.y + 8,
        "Continue",
        Action::Settings(SettingsAction::ContinueMfw),
        settings.mfw_available || settings.mfw_step > 1,
    );
}

fn draw_project(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let scroll = app.view_model().settings.scroll;
    let mut y = 0u16;
    if let Some(rect) = slot(area, scroll, y, 3) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "Project Page & Services",
                    Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "Inspect Monero Fast Wallet, its public services, and the open-source components behind them.",
                    Style::default().fg(MUTED),
                )),
            ])
            .wrap(Wrap { trim: true }),
            rect,
        );
    }
    y += 3;
    draw_chip(
        app,
        frame,
        area.x,
        area.y,
        "← Back",
        Action::OpenMenu(crate::settings::MenuItem::Settings),
        false,
    );
    y += 1;
    if let Some(rect) = slot(area, scroll, y, 2) {
        frame.render_widget(
            Paragraph::new(Span::styled(
                "Official addresses",
                Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
            )),
            rect,
        );
    }
    y += 2;
    for address in PROJECT_ADDRESSES {
        if let Some(rect) = slot(area, scroll, y, 3) {
            frame.render_widget(
                Block::default()
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(Style::default().fg(CARD_EDGE))
                    .style(Style::default().bg(CARD)),
                rect,
            );
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(Span::styled(
                        format!("{}  ·  {}", address.label, address.transport),
                        Style::default().fg(TEXT).add_modifier(Modifier::BOLD),
                    )),
                    Line::from(Span::styled(
                        address.address,
                        Style::default().fg(ORANGE_SOFT),
                    )),
                ]),
                shrink(rect, 1, 0, 2, 0),
            );
        }
        y += 4;
    }
    if let Some(rect) = slot(area, scroll, y, 2) {
        frame.render_widget(
            Paragraph::new(Span::styled(
                "Onion links require a Tor-capable browser. Opening any link leaves the wallet app.",
                Style::default().fg(MUTED),
            )),
            rect,
        );
    }
    y += 3;
    if let Some(rect) = slot(area, scroll, y, 5) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "Run it yourself",
                    Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "Your own Monero Fast Node  ·  enter Clearnet gRPC and Onion daemon under Node Status.",
                    Style::default().fg(MUTED),
                )),
                Line::from(Span::styled(
                    "Your own Fast Wallet Worker  ·  pair its signed descriptor under Settings → Fast Wallet Worker.",
                    Style::default().fg(MUTED),
                )),
            ])
            .wrap(Wrap { trim: true }),
            rect,
        );
    }
    y += 6;
    if let Some(rect) = slot(area, scroll, y, 8) {
        let mut lines = vec![Line::from(Span::styled(
            "Services",
            Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
        ))];
        for service in PROJECT_SERVICES {
            lines.push(Line::from(Span::styled(
                format!("  ›  {service}"),
                Style::default().fg(TEXT),
            )));
        }
        lines.push(Line::from(Span::styled(
            "  ›  Source code   github.com/tex8com/monero-fast-wallet",
            Style::default().fg(ORANGE_SOFT),
        )));
        frame.render_widget(Paragraph::new(lines), rect);
    }
}

fn draw_footer(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let model = app.view_model();
    let command = if app.focused_field() == Field::Command {
        format!("  ▸ {}█", model.command)
    } else {
        format!(
            "  ▸  {}",
            if model.command.is_empty() {
                if model.screen == ScreenKind::SeedBackup {
                    "Enter  confirm seed backup"
                } else {
                    "b  s  a  m  settings  q"
                }
            } else {
                &model.command
            }
        )
    };
    let status = model.error.clone().unwrap_or(model.status);
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Length(1)])
        .split(area);
    frame.render_widget(
        Paragraph::new(command).style(Style::default().fg(ORANGE_SOFT).bg(INPUT)),
        chunks[0],
    );
    let style = if model.error.is_some() {
        Style::default().fg(DANGER).bg(BG)
    } else {
        Style::default().fg(MUTED).bg(BG)
    };
    frame.render_widget(
        Paragraph::new(format!("  {status}")).style(style),
        chunks[1],
    );
    app.hits.push(Hit {
        x: area.x,
        y: chunks[0].y,
        width: area.width,
        height: 1,
        action: Action::Focus(Field::Command),
    });
    if model.sync.failed || status.contains("Node unreachable") || status.contains("Node check") {
        app.hits.push(Hit {
            x: area.x,
            y: chunks[1].y,
            width: area.width,
            height: 1,
            action: Action::OpenMenu(crate::settings::MenuItem::Node),
        });
    }
}

fn draw_input(
    app: &mut App,
    frame: &mut Frame<'_>,
    area: Rect,
    label: &str,
    value: &str,
    field: Field,
) -> u16 {
    let Some(area) = clamp_to_frame(frame, area.x, area.y, area.width, area.height.max(1)) else {
        return area.y;
    };
    frame.render_widget(
        Paragraph::new(Span::styled(label, Style::default().fg(MUTED))),
        Rect {
            x: area.x,
            y: area.y,
            width: area.width,
            height: 1,
        },
    );
    let box_y = area.y + 1;
    let focused = app.focused_field() == field;
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(if focused { ORANGE } else { CARD_EDGE }))
            .style(Style::default().bg(INPUT)),
        Rect {
            x: area.x,
            y: box_y,
            width: area.width,
            height: 3,
        },
    );
    frame.render_widget(
        Paragraph::new(Span::styled(
            value,
            Style::default().fg(if focused { TEXT } else { MUTED }),
        )),
        Rect {
            x: area.x + 2,
            y: box_y + 1,
            width: area.width.saturating_sub(4),
            height: 1,
        },
    );
    app.hits.push(Hit {
        x: area.x,
        y: box_y,
        width: area.width,
        height: 3,
        action: Action::Focus(field),
    });
    area.y + 4
}

fn clamp_to_frame(frame: &Frame<'_>, x: u16, y: u16, width: u16, height: u16) -> Option<Rect> {
    let bounds = frame.area();
    if x >= bounds.x.saturating_add(bounds.width) || y >= bounds.y.saturating_add(bounds.height) {
        return None;
    }
    let width = width.min(bounds.x.saturating_add(bounds.width).saturating_sub(x));
    let height = height.min(bounds.y.saturating_add(bounds.height).saturating_sub(y));
    if width == 0 || height == 0 {
        return None;
    }
    Some(Rect {
        x,
        y,
        width,
        height,
    })
}

fn draw_primary(app: &mut App, frame: &mut Frame<'_>, x: u16, y: u16, label: &str, action: Action) {
    let width = (label.len() as u16).saturating_add(4).max(12);
    let Some(rect) = clamp_to_frame(frame, x, y, width, 1) else {
        return;
    };
    frame.render_widget(
        Paragraph::new(format!(" {label} "))
            .alignment(Alignment::Center)
            .style(
                Style::default()
                    .fg(PRIMARY_FG)
                    .bg(ORANGE)
                    .add_modifier(Modifier::BOLD),
            ),
        rect,
    );
    app.hits.push(Hit {
        x,
        y,
        width,
        height: 1,
        action,
    });
}

fn draw_chip(
    app: &mut App,
    frame: &mut Frame<'_>,
    x: u16,
    y: u16,
    label: &str,
    action: Action,
    selected: bool,
) {
    let width = (label.len() as u16).saturating_add(2).max(8);
    let Some(rect) = clamp_to_frame(frame, x, y, width, 1) else {
        return;
    };
    let style = if selected {
        Style::default()
            .fg(PRIMARY_FG)
            .bg(ORANGE)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(NAV).bg(INPUT)
    };
    frame.render_widget(Paragraph::new(format!(" {label} ")).style(style), rect);
    app.hits.push(Hit {
        x,
        y,
        width,
        height: 1,
        action,
    });
}

fn shrink(area: Rect, x: u16, y: u16, w: u16, h: u16) -> Rect {
    Rect {
        x: area.x.saturating_add(x),
        y: area.y.saturating_add(y),
        width: area.width.saturating_sub(w),
        height: area.height.saturating_sub(h),
    }
}

fn field_value(value: &str, focused: bool) -> String {
    let shown = if value.is_empty() { "…" } else { value };
    if focused {
        format!("{shown}█")
    } else {
        shown.to_owned()
    }
}

fn shorten(address: &str) -> String {
    if address.len() <= 20 {
        address.to_owned()
    } else {
        format!("{}····{}", &address[..8], &address[address.len() - 8..])
    }
}

fn render_qr(data: &str) -> String {
    match qrcode::QrCode::new(data.as_bytes()) {
        Ok(code) => code
            .render::<char>()
            .quiet_zone(false)
            .module_dimensions(1, 1)
            .dark_color('█')
            .light_color(' ')
            .build(),
        Err(_) => "QR unavailable".into(),
    }
}

#[allow(dead_code)]
fn mask(value: &str) -> String {
    mask_secret(value)
}
