#![no_std]

use aidoku::{
    alloc::{
        format,
        string::{String, ToString},
        vec::Vec,
    },
    helpers::uri::encode_uri_component,
    imports::net::Request,
    prelude::*,
    Chapter, ContentRating, ImageRequestProvider, Listing, ListingProvider, Manga, MangaPageResult,
    MangaStatus, Page, PageContent, PageContext, Result, Source,
};
use serde::Deserialize;

const BASE_URL: &str = "https://m440.in";
const CLOUD_URL: &str = "__YREPO_CLOUD_URL__";

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    suggestions: Vec<SearchSuggestion>,
}

#[derive(Deserialize)]
struct SearchSuggestion {
    value: String,
    data: String,
}

#[derive(Deserialize)]
struct LatestResponse {
    #[serde(default)]
    data: Vec<LatestManga>,
    #[serde(rename = "totalPages")]
    total_pages: i32,
}

#[derive(Deserialize)]
struct LatestManga {
    #[serde(rename = "manga_name")]
    name: String,
    #[serde(rename = "manga_slug")]
    slug: String,
}

#[derive(Deserialize)]
struct ProxyChapter {
    slug: String,
    name: String,
    number: String,
    #[serde(rename = "created_at")]
    _created_at: Option<String>,
}

struct M440;

impl M440 {
    fn request(request: Request) -> Request {
        request
            .header("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
            .header("Accept-Language", "es-CL,es;q=0.9,en;q=0.8")
            .header("Referer", "https://m440.in/")
            .header(
                "User-Agent",
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
            )
    }

    fn absolute_url(value: &str) -> String {
        let clean = value.trim();

        if clean.starts_with("https://") || clean.starts_with("http://") {
            clean.into()
        } else if clean.starts_with("//") {
            format!("https:{clean}")
        } else if clean.starts_with('/') {
            format!("{BASE_URL}{clean}")
        } else {
            format!("{BASE_URL}/{clean}")
        }
    }

    fn slug_from_url(value: &str) -> String {
        value
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_string()
    }

    fn cover_for(slug: &str) -> String {
        format!("{BASE_URL}/uploads/manga/{slug}/cover/cover_250x350.jpg")
    }

    fn manga_from_slug(slug: String, title: String) -> Manga {
        Manga {
            key: slug.clone(),
            title,
            cover: Some(Self::cover_for(&slug)),
            url: Some(format!("{BASE_URL}/manga/{slug}")),
            content_rating: ContentRating::NSFW,
            ..Default::default()
        }
    }

    fn parse_cards(url: &str) -> Result<MangaPageResult> {
        let document = Self::request(Request::get(url)?).html()?;
        let mut entries = Vec::new();

        if let Some(cards) = document.select("div.media") {
            for card in cards {
                let Some(anchor) = card.select_first(".media-heading a, .manga-heading a") else {
                    continue;
                };

                let href = anchor.attr("abs:href").unwrap_or_default();
                let key = Self::slug_from_url(&href);
                let title = anchor.text().unwrap_or_default();

                if key.is_empty() || title.is_empty() {
                    continue;
                }

                let cover = card
                    .select_first("img")
                    .and_then(|image| {
                        image
                            .attr("abs:data-background-image")
                            .filter(|value| !value.is_empty())
                            .or_else(|| {
                                image
                                    .attr("abs:data-cfsrc")
                                    .filter(|value| !value.is_empty())
                            })
                            .or_else(|| {
                                image
                                    .attr("abs:data-lazy-src")
                                    .filter(|value| !value.is_empty())
                            })
                            .or_else(|| {
                                image
                                    .attr("abs:data-src")
                                    .filter(|value| !value.is_empty())
                            })
                            .or_else(|| image.attr("abs:src"))
                    })
                    .filter(|value| !value.ends_with("no-image.png"))
                    .or_else(|| Some(Self::cover_for(&key)));

                entries.push(Manga {
                    key,
                    title,
                    cover,
                    url: Some(href),
                    content_rating: ContentRating::NSFW,
                    ..Default::default()
                });
            }
        }

        let has_next_page = document
            .select_first(".pagination a[rel=next]")
            .is_some();

        Ok(MangaPageResult {
            entries,
            has_next_page,
        })
    }

    fn popular(page: i32) -> Result<MangaPageResult> {
        Self::parse_cards(&format!(
            "{BASE_URL}/filterList?page={page}&sortBy=views&asc=false"
        ))
    }

    fn latest(page: i32) -> Result<MangaPageResult> {
        let response: LatestResponse = Self::request(Request::get(format!(
            "{BASE_URL}/lasted?p={page}"
        ))?)
        .header("Accept", "application/json, text/plain, */*")
        .json_owned()?;

        let entries = response
            .data
            .into_iter()
            .map(|item| Self::manga_from_slug(item.slug, item.name))
            .collect();

        Ok(MangaPageResult {
            entries,
            has_next_page: page < response.total_pages,
        })
    }

    fn search(query: &str) -> Result<MangaPageResult> {
        let encoded = encode_uri_component(query);
        let response: SearchResponse = Self::request(Request::get(format!(
            "{BASE_URL}/search?q={encoded}"
        ))?)
        .header("Accept", "application/json, text/plain, */*")
        .json_owned()?;

        let entries = response
            .suggestions
            .into_iter()
            .map(|item| Self::manga_from_slug(item.data, item.value))
            .collect();

        Ok(MangaPageResult {
            entries,
            has_next_page: false,
        })
    }

    fn parse_status(value: &str) -> MangaStatus {
        let normalized = value.trim().to_lowercase();

        match normalized.as_str() {
            "ongoing" | "activo" | "en curso" | "en emisión" | "en emision" => {
                MangaStatus::Ongoing
            }
            "complete" | "completo" | "finalizado" | "completado" => {
                MangaStatus::Completed
            }
            "dropped" | "cancelado" | "cancelada" => MangaStatus::Cancelled,
            "hiatus" | "pausado" | "pausada" => MangaStatus::Hiatus,
            _ => MangaStatus::Unknown,
        }
    }

    fn chapters(manga_url: &str) -> Result<Vec<Chapter>> {
        let encoded = encode_uri_component(manga_url);
        let url = format!("{CLOUD_URL}/m440/chapters?url={encoded}");

        let items: Vec<ProxyChapter> = Self::request(Request::get(url)?)
            .header("Accept", "application/json")
            .json_owned()?;

        Ok(items
            .into_iter()
            .map(|item| {
                let number = item.number.parse::<f32>().ok();
                let generic = format!("Capítulo {}", item.number);
                let name = item.name.trim();

                let title = if name.is_empty() || name == generic {
                    Some(generic)
                } else {
                    Some(format!("{generic}: {name}"))
                };

                Chapter {
                    key: item.slug.clone(),
                    title,
                    chapter_number: number,
                    url: Some(format!("{manga_url}/{}", item.slug)),
                    language: Some("es".into()),
                    ..Default::default()
                }
            })
            .collect())
    }
}

impl Source for M440 {
    fn new() -> Self {
        Self
    }

    fn get_search_manga_list(
        &self,
        query: Option<String>,
        page: i32,
        _filters: Vec<aidoku::FilterValue>,
    ) -> Result<MangaPageResult> {
        match query {
            Some(value) if !value.trim().is_empty() => {
                if page > 1 {
                    Ok(MangaPageResult {
                        entries: Vec::new(),
                        has_next_page: false,
                    })
                } else {
                    Self::search(value.trim())
                }
            }
            _ => Self::popular(page),
        }
    }

    fn get_manga_update(
        &self,
        mut manga: Manga,
        needs_details: bool,
        needs_chapters: bool,
    ) -> Result<Manga> {
        let manga_url = manga
            .url
            .clone()
            .unwrap_or_else(|| format!("{BASE_URL}/manga/{}", manga.key));

        if needs_details {
            let document = Self::request(Request::get(manga_url.clone())?).html()?;

            if let Some(title) = document
                .select_first(".listmanga-header, .widget-title, div.manga-name h1, h1")
                .and_then(|item| item.text())
                .filter(|value| !value.is_empty())
            {
                manga.title = title;
            }

            manga.cover = document
                .select_first(".row img.img-responsive, div.manga-cover img, img.img-responsive")
                .and_then(|image| {
                    image
                        .attr("abs:data-src")
                        .filter(|value| !value.is_empty())
                        .or_else(|| image.attr("abs:src"))
                })
                .or(manga.cover)
                .or_else(|| Some(Self::cover_for(&manga.key)));

            manga.description = document
                .select_first(".row .well, div.manga-description, div.description")
                .and_then(|item| item.text())
                .filter(|value| !value.is_empty());

            if let Some(status) = document
                .select_first("div.manga-name span.label")
                .and_then(|item| item.text())
            {
                manga.status = Self::parse_status(&status);
            }

            manga.url = Some(manga_url.clone());
            manga.content_rating = ContentRating::NSFW;
        }

        if needs_chapters {
            manga.chapters = Some(Self::chapters(&manga_url)?);
        }

        Ok(manga)
    }

    fn get_page_list(&self, _manga: Manga, chapter: Chapter) -> Result<Vec<Page>> {
        let chapter_url = match chapter.url {
            Some(value) if !value.is_empty() => value,
            _ => bail!("Falta la URL del capítulo."),
        };

        let document = Self::request(Request::get(chapter_url)?).html()?;
        let mut pages = Vec::new();

        if let Some(images) = document.select("#all > img.img-responsive") {
            for image in images {
                let url = image
                    .attr("abs:data-background-image")
                    .filter(|value| !value.is_empty())
                    .or_else(|| {
                        image
                            .attr("abs:data-cfsrc")
                            .filter(|value| !value.is_empty())
                    })
                    .or_else(|| {
                        image
                            .attr("abs:data-lazy-src")
                            .filter(|value| !value.is_empty())
                    })
                    .or_else(|| {
                        image
                            .attr("abs:data-src")
                            .filter(|value| !value.is_empty())
                    })
                    .or_else(|| image.attr("abs:src"))
                    .unwrap_or_default();

                if url.is_empty() {
                    continue;
                }

                pages.push(Page {
                    content: PageContent::url(Self::absolute_url(&url)),
                    ..Default::default()
                });
            }
        }

        if pages.is_empty() {
            bail!("M440 no devolvió páginas para este capítulo.");
        }

        Ok(pages)
    }
}

impl ListingProvider for M440 {
    fn get_manga_list(&self, listing: Listing, page: i32) -> Result<MangaPageResult> {
        match listing.id.as_str() {
            "popular" => Self::popular(page),
            "latest" => Self::latest(page),
            _ => bail!("Listado no compatible."),
        }
    }
}

impl ImageRequestProvider for M440 {
    fn get_image_request(&self, url: String, _context: Option<PageContext>) -> Result<Request> {
        Ok(Request::get(url)?
            .header("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
            .header("Accept-Language", "es-CL,es;q=0.9,en;q=0.8")
            .header("Referer", "https://m440.in/")
            .header(
                "User-Agent",
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
            ))
    }
}

register_source!(M440, ListingProvider, ImageRequestProvider);
