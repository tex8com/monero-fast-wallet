use super::{NewsCategory, NewsItem};

const PUBLIC_BASE: &str = "https://xmr.tex8.com/news/articles";
const IMAGE_BASE: &str = "https://cdn.tex8.com/tex8-images/monero-fast-wallet/news/v1/2026-10-06";

#[derive(Clone, Copy)]
pub(crate) struct Section {
    pub heading: &'static str,
    pub body: &'static str,
}

#[derive(Clone, Copy)]
pub(crate) struct Source {
    pub label: &'static str,
    pub url: &'static str,
}

#[derive(Clone, Copy)]
pub(crate) struct Article {
    pub slug: &'static str,
    pub title: &'static str,
    pub summary: &'static str,
    pub published_at: &'static str,
    pub category: NewsCategory,
    pub image_name: &'static str,
    pub lead: &'static str,
    pub sections: &'static [Section],
    pub source: Option<Source>,
}

const ARTICLES: &[Article] = &[
    Article {
        slug: "monero-0-18-5-3-stabilere-verbindungen",
        title: "Monero 0.18.5.3: Fokus auf stabilere Verbindungen",
        summary: "Das neue Monero-Release behebt mehrere Probleme bei P2P-Verbindungen, Block-Relay und Neustarts. Ein Update wird empfohlen.",
        published_at: "2026-10-06T18:00:00Z",
        category: NewsCategory::Network,
        image_name: "monero-0-18-5-3",
        lead: "Monero 0.18.5.3 „Fluorine Fermi“ ist eine Wartungsversion mit wichtigen Korrekturen für die Zuverlässigkeit des Netzwerks.",
        sections: &[
            Section {
                heading: "Was verbessert wurde",
                body: "Die Version korrigiert unter anderem festhängende P2P-Verbindungen, Probleme beim erneuten Relay nach einem Neustart sowie mehrere Sonderfälle bei Block- und Transaktionsübertragung.",
            },
            Section {
                heading: "Was Nutzer tun sollten",
                body: "Wer einen eigenen Monero-Node betreibt, sollte die offiziellen Release-Hinweise prüfen und das Update zeitnah einplanen. Wallet-Nutzer profitieren automatisch, sobald ihr gewählter Node aktualisiert wurde.",
            },
        ],
        source: Some(Source {
            label: "Offizielle Monero-Release-Hinweise",
            url: "https://www.getmonero.org/2026/10/06/monero-0.18.5.3-released.html",
        }),
    },
    Article {
        slug: "monero-privatsphaere-einfach-erklaert",
        title: "Monero-Privatsphäre einfach erklärt",
        summary: "Stealth-Adressen, Ringsignaturen und vertrauliche Beträge schützen verschiedene Teile einer Zahlung gemeinsam.",
        published_at: "2026-10-06T17:00:00Z",
        category: NewsCategory::Network,
        image_name: "monero-privacy-basics",
        lead: "Bei Monero sind Empfänger, Betrag und die genaue Herkunft einer Zahlung nicht wie bei transparenten Blockchains öffentlich ablesbar.",
        sections: &[
            Section {
                heading: "Drei Schutzschichten",
                body: "Stealth-Adressen erzeugen für jede Zahlung ein neues Ziel. Ringsignaturen erschweren die Zuordnung des ausgegebenen Outputs. Vertrauliche Transaktionen verbergen den übertragenen Betrag.",
            },
            Section {
                heading: "Privatsphäre bleibt eine Praxisfrage",
                body: "Das Protokoll schützt die Blockchain-Daten. Geräte, Backups, Netzwerkzugang und der Umgang mit Adressen müssen trotzdem sorgfältig abgesichert werden.",
            },
        ],
        source: Some(Source {
            label: "Monero: Was ist Monero?",
            url: "https://www.getmonero.org/get-started/what-is-monero/",
        }),
    },
    Article {
        slug: "monero-fast-wallet-selbstverwahrung",
        title: "Monero Fast Wallet: Selbstverwahrung ohne Abkürzungen",
        summary: "Seed und Spend Key bleiben beim Nutzer. Der schnellere Datenweg ersetzt weder Signaturen noch die Sicherheitsregeln von Monero.",
        published_at: "2026-10-06T16:00:00Z",
        category: NewsCategory::Wallet,
        image_name: "monero-fast-wallet-self-custody",
        lead: "Monero Fast Wallet verbindet einen schnelleren Synchronisationsweg mit lokaler Schlüsselverwaltung.",
        sections: &[
            Section {
                heading: "Was lokal bleibt",
                body: "Seed, Spend Key und Transaktionssignaturen verlassen das Gerät nicht. Ein Node liefert Blockchain-Daten und überträgt signierte Transaktionen, kann aber nicht eigenständig über Guthaben verfügen.",
            },
            Section {
                heading: "Was Nutzer sichern müssen",
                body: "Die Wiederherstellungswörter sind der entscheidende Zugang zur Wallet. Sie gehören offline gesichert und dürfen nie in Webseiten, Chats oder fremde Apps eingegeben werden.",
            },
        ],
        source: None,
    },
    Article {
        slug: "monero-fast-node-datenweg",
        title: "Monero Fast Node: Was den schnelleren Datenweg ausmacht",
        summary: "Monero Fast Node ergänzt den normalen Node-Zugang um einen für Wallet-Synchronisation optimierten, überprüfbaren Datenstrom.",
        published_at: "2026-10-06T15:00:00Z",
        category: NewsCategory::Network,
        image_name: "monero-fast-node",
        lead: "Wallets benötigen viele Blockchain-Daten, müssen daraus aber nur die für ihre eigenen Schlüssel relevanten Zahlungen erkennen.",
        sections: &[
            Section {
                heading: "Optimierter Transport",
                body: "Monero Fast Node stellt kompatiblen Wallets Daten in kleinen, fortlaufend prüfbaren Abschnitten bereit. Der klassische Monero-RPC-Zugang bleibt für Kompatibilität erhalten.",
            },
            Section {
                heading: "Keine Verwahrung",
                body: "Der Node kennt den Spend Key nicht und signiert keine normalen Wallet-Transaktionen. Die endgültige Prüfung relevanter Daten erfolgt weiterhin in der Wallet.",
            },
        ],
        source: None,
    },
    Article {
        slug: "wallet-sync-fortschritt",
        title: "Wallet-Sync: Warum sichtbarer Fortschritt wichtig ist",
        summary: "Blockchain-Download und Wallet-Scan sind zwei getrennte Schritte. Klare Statuswerte zeigen, welcher Teil gerade arbeitet.",
        published_at: "2026-10-06T14:00:00Z",
        category: NewsCategory::Wallet,
        image_name: "wallet-sync",
        lead: "Eine Wallet kann Blockchain-Daten bereits geladen haben und trotzdem noch eigene Zahlungen suchen. Deshalb zeigt Monero Fast Wallet beide Fortschritte getrennt.",
        sections: &[
            Section {
                heading: "Blockchain-Daten",
                body: "Zuerst werden fehlende Blöcke vom gewählten Node übertragen und geprüft. Netzwerkgeschwindigkeit und Antwortzeit des Nodes beeinflussen diesen Teil.",
            },
            Section {
                heading: "Wallet-Scan",
                body: "Danach oder parallel prüft die Wallet die Blöcke mit dem View Key auf relevante Ausgänge. Dieser kryptografische Scan benötigt Rechenzeit und kann bei Hardware-Wallets zusätzliche Schritte erfordern.",
            },
        ],
        source: None,
    },
    Article {
        slug: "ledger-mit-monero-fast-wallet",
        title: "Ledger mit Monero Fast Wallet: Was auf dem Gerät bleibt",
        summary: "Beim Hardware-Wallet bleiben private Schlüssel im Ledger. Freigaben müssen auf seinem Display kontrolliert werden.",
        published_at: "2026-10-06T13:00:00Z",
        category: NewsCategory::Wallet,
        image_name: "ledger-hardware-wallet",
        lead: "Ein Hardware-Wallet trennt die besonders sensiblen Schlüssel vom Computer oder Smartphone.",
        sections: &[
            Section {
                heading: "Vorbereitung und Scan",
                body: "Die Wallet lädt Blockchain-Daten und bereitet die zu signierende Transaktion vor. Je nach Vorgang muss der Ledger zusätzlich kryptografische Daten liefern oder prüfen.",
            },
            Section {
                heading: "Freigabe am Gerät",
                body: "Empfänger, Betrag und Gebühr müssen vor der Bestätigung auf dem Ledger geprüft werden. Erst die Hardware-Freigabe erzeugt die notwendige Signatur.",
            },
        ],
        source: Some(Source {
            label: "Offizielle Monero-Anleitung für Ledger",
            url: "https://www.getmonero.org/resources/user-guides/ledger-wallet-cli.html",
        }),
    },
    Article {
        slug: "mfw-namen-zwei-schritte",
        title: ".mfw-Namen: Warum die Registrierung zwei Schritte nutzt",
        summary: "Commit und Claim verhindern, dass ein öffentlich sichtbarer Kaufversuch unmittelbar kopiert und vorweggenommen wird.",
        published_at: "2026-10-06T12:00:00Z",
        category: NewsCategory::Ecosystem,
        image_name: "mfw-names",
        lead: "Die Namensregistrierung nutzt bewusst zwei Blockchain-Transaktionen: zuerst eine verdeckte Festlegung, danach die eigentliche Veröffentlichung.",
        sections: &[
            Section {
                heading: "Schritt 1: Commit",
                body: "Die erste Transaktion bindet die spätere Registrierung, ohne den Namen offen in den Mempool zu legen. Nach der vorgeschriebenen Reifezeit kann der Claim gültig werden.",
            },
            Section {
                heading: "Schritt 2: Claim",
                body: "Die zweite Transaktion veröffentlicht den Namen und bezahlt die Laufzeit. Beim Monero Fast Node kann eine bereits signierte Claim-Transaktion bis zur gültigen Blockhöhe sicher zurückgehalten und dann übertragen werden.",
            },
        ],
        source: None,
    },
];

pub(crate) fn find(slug: &str) -> Option<&'static Article> {
    ARTICLES.iter().find(|article| article.slug == slug)
}

pub(crate) fn news_items() -> Vec<NewsItem> {
    ARTICLES
        .iter()
        .map(|article| NewsItem {
            id: article.slug.to_owned(),
            title: article.title.to_owned(),
            summary: article.summary.to_owned(),
            published_at: article.published_at.to_owned(),
            category: article.category,
            url: format!("{PUBLIC_BASE}/{}", article.slug),
            image_url: format!("{IMAGE_BASE}/{}.webp", article.image_name),
        })
        .collect()
}

fn page_shell(title: &str, description: &str, image_url: &str, content: &str) -> String {
    format!(
        r#"<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} · Monero Fast Wallet</title><meta name="description" content="{description}"><meta property="og:title" content="{title}"><meta property="og:description" content="{description}"><meta property="og:image" content="{image_url}"><meta name="color-scheme" content="dark"><style>{style}</style></head><body><header><a href="/news/articles">Monero <strong>Fast Wallet</strong></a></header>{content}<footer>Informationen, keine Finanzberatung · Monero Fast Wallet</footer></body></html>"#,
        style = "*{box-sizing:border-box}body{margin:0;background:#080812;color:#f7f4fb;font:17px/1.65 system-ui,-apple-system,sans-serif}header,main,footer{width:min(920px,calc(100% - 40px));margin:auto}header{padding:28px 0}a{color:#ff6b21;text-decoration:none}strong{color:#ff6b21}main{padding:22px 0 70px}.hero{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:24px;border:1px solid #36304b}.tag{color:#ff7a36;text-transform:uppercase;letter-spacing:.12em;font-weight:700;font-size:.8rem}h1{font-size:clamp(2.2rem,7vw,4.6rem);line-height:1.03;margin:.4em 0}h2{margin-top:2em}.lead{font-size:1.25rem;color:#d7d0df}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}.card{display:block;color:inherit;background:#151326;border:1px solid #35304a;border-radius:18px;overflow:hidden}.card img{width:100%;aspect-ratio:16/9;object-fit:cover}.card div{padding:18px}.card h2{margin:0 0 8px;font-size:1.2rem}.card p{margin:0;color:#bdb5c8}footer{border-top:1px solid #2b263b;padding:30px 0 60px;color:#898298}",
    )
}

pub(crate) fn render_index() -> String {
    let cards = ARTICLES
        .iter()
        .map(|article| {
            format!(
                r#"<a class="card" href="/news/articles/{slug}"><img src="{image}" alt=""><div><span class="tag">{category}</span><h2>{title}</h2><p>{summary}</p></div></a>"#,
                slug = article.slug,
                image = format!("{IMAGE_BASE}/{}.webp", article.image_name),
                category = category_label(article.category),
                title = article.title,
                summary = article.summary,
            )
        })
        .collect::<String>();
    page_shell(
        "Monero-News",
        "Aktuelle Monero-News und verständliche Artikel zu Monero Fast Wallet und Monero Fast Node.",
        &format!("{IMAGE_BASE}/monero-0-18-5-3.webp"),
        &format!(r#"<main><p class="tag">News & Wissen</p><h1>Monero-News</h1><p class="lead">Aktuelles aus dem Monero-Netzwerk und klare Erklärungen zu Monero Fast Wallet und Monero Fast Node.</p><section class="grid">{cards}</section></main>"#),
    )
}

pub(crate) fn render_article(article: &Article) -> String {
    let sections = article
        .sections
        .iter()
        .map(|section| {
            format!(
                "<section><h2>{}</h2><p>{}</p></section>",
                section.heading, section.body
            )
        })
        .collect::<String>();
    let source = article.source.map_or_else(String::new, |source| {
        format!(
            r#"<p><a href="{}" rel="noopener noreferrer">{} →</a></p>"#,
            source.url, source.label
        )
    });
    let image = format!("{IMAGE_BASE}/{}.webp", article.image_name);
    page_shell(
        article.title,
        article.summary,
        &image,
        &format!(
            r#"<main><p><a href="/news/articles">← Alle Artikel</a></p><img class="hero" src="{image}" alt=""><p class="tag">{category}</p><h1>{title}</h1><p class="lead">{lead}</p>{sections}{source}</main>"#,
            category = category_label(article.category),
            title = article.title,
            lead = article.lead,
        ),
    )
}

fn category_label(category: NewsCategory) -> &'static str {
    match category {
        NewsCategory::Network => "Netzwerk",
        NewsCategory::Wallet => "Wallet",
        NewsCategory::Ecosystem => "Ökosystem",
    }
}
