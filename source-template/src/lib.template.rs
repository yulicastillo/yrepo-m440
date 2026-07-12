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
use core::cmp::Ordering;
use serde::Deserialize;

const BASE_URL: &str = "https://inmanga.com";
const IMAGE_CDN: &str = "https://cdn1.intomanga.com";
const PAGE_SIZE: i32 = 10;

#[derive(Deserialize)]
struct InMangaResultDto {
    data: Option<String>,
}

#[derive(Deserialize)]
struct InMangaResultObjectDto<T> {
    success: bool,
    #[serde(default)]
    result: Vec<T>,
}

#[derive(Deserialize, Default)]
struct InMangaChapterDto {
    #[serde(rename = "Number")]
    number: Option<f64>,
    #[serde(rename = "RegistrationDate")]
    _registration_date: String,
    #[serde(rename = "Identification")]
    identification: Option<String>,
    #[serde(rename = "FriendlyChapterNumber")]
    friendly_chapter_number: Option<String>,
}

struct InManga;

impl InManga {
    fn request_headers(request: Request) -> Request {
        request
            .header("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
            .header("Accept-Language", "es-CL,es;q=0.9,en;q=0.8")
            .header("Referer", "https://inmanga.com/")
            .header(
                "User-Agent",
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
            )
    }

    fn absolute_url(value: &str) -> String {
        let clean = value.trim();
        if clean.starts_with("http://") || clean.starts_with("https://") {
            clean.into()
        } else if clean.starts_with('/') {
            format!("{BASE_URL}{clean}")
        } else {
            format!("{BASE_URL}/{clean}")
        }
    }

    fn manga_id_from_url(url: &str) -> String {
        url.trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_string()
    }

    fn manga_list(page: i32, query: &str, sort_by: i32) -> Result<MangaPageResult> {
        let skip = (page.saturating_sub(1)) * PAGE_SIZE;
        let encoded_query = encode_uri_component(query);
        let body = format!(
            "filter%5Bgeneres%5D%5B%5D=-1&filter%5BqueryString%5D={encoded_query}&filter%5Bskip%5D={skip}&filter%5Btake%5D={PAGE_SIZE}&filter%5Bsortby%5D={sort_by}&filter%5BbroadcastStatus%5D=0&filter%5BonlyFavorites%5D=false&d="
        );

        let document = Self::request_headers(Request::post(format!(
            "{BASE_URL}/manga/getMangasConsultResult"
        ))?)
        .header(
            "Content-Type",
            "application/x-www-form-urlencoded; charset=UTF-8",
        )
        .header("X-Requested-With", "XMLHttpRequest")
        .body(body)
        .html()?;

        let mut entries = Vec::new();

        if let Some(elements) = document.select("body > a") {
            for element in elements {
                let href = element.attr("abs:href").unwrap_or_default();
                let key = Self::manga_id_from_url(&href);
                let title = element
                    .select_first("h4.m0")
                    .and_then(|item| item.text())
                    .unwrap_or_default();
                let cover = element.select_first("img").and_then(|image| {
                    image
                        .attr("abs:data-src")
                        .filter(|value| !value.is_empty())
                        .or_else(|| image.attr("abs:src"))
                });

                if key.is_empty() || title.is_empty() {
                    continue;
                }

                entries.push(Manga {
                    key,
                    title,
                    cover,
                    url: Some(href),
                    content_rating: ContentRating::Safe,
                    ..Default::default()
                });
            }
        }

        let has_next_page = entries.len() == PAGE_SIZE as usize;

        Ok(MangaPageResult {
            entries,
            has_next_page,
        })
    }

    fn parse_status(value: &str) -> MangaStatus {
        let status = value.to_lowercase();
        if status.contains("en emisión") || status.contains("en emision") {
            MangaStatus::Ongoing
        } else if status.contains("finalizado") {
            MangaStatus::Completed
        } else if status.contains("pausado") || status.contains("hiatus") {
            MangaStatus::Hiatus
        } else if status.contains("cancelado") {
            MangaStatus::Cancelled
        } else {
            MangaStatus::Unknown
        }
    }

    fn chapter_list(manga_id: &str) -> Result<Vec<Chapter>> {
        let outer: InMangaResultDto = Self::request_headers(Request::get(format!(
            "{BASE_URL}/chapter/getall?mangaIdentification={manga_id}"
        ))?)
        .header("Accept", "application/json, text/plain, */*")
        .json_owned()?;

        let Some(data) = outer.data else {
            return Ok(Vec::new());
        };

        if data.trim().is_empty() {
            return Ok(Vec::new());
        }

        let inner: InMangaResultObjectDto<InMangaChapterDto> =
            serde_json::from_str(&data)?;

        if !inner.success {
            return Ok(Vec::new());
        }

        let mut chapters = Vec::new();

        for item in inner.result {
            let key = item.identification.unwrap_or_default();
            if key.is_empty() {
                continue;
            }

            let number = item.number.map(|value| value as f32);
            let friendly = item
                .friendly_chapter_number
                .unwrap_or_else(|| number.map(|value| value.to_string()).unwrap_or_default());

            chapters.push(Chapter {
                key: key.clone(),
                title: if friendly.is_empty() {
                    None
                } else {
                    Some(format!("Capítulo {friendly}"))
                },
                chapter_number: number,
                url: Some(format!(
                    "{BASE_URL}/chapter/chapterIndexControls?identification={key}"
                )),
                language: Some("es".into()),
                ..Default::default()
            });
        }

        chapters.sort_by(|left, right| {
            right
                .chapter_number
                .partial_cmp(&left.chapter_number)
                .unwrap_or(Ordering::Equal)
        });

        Ok(chapters)
    }
}

impl Source for InManga {
    fn new() -> Self {
        Self
    }

    fn get_search_manga_list(
        &self,
        query: Option<String>,
        page: i32,
        _filters: Vec<aidoku::FilterValue>,
    ) -> Result<MangaPageResult> {
        let query = query.unwrap_or_default();
        Self::manga_list(page, query.trim(), 1)
    }

    fn get_manga_update(
        &self,
        mut manga: Manga,
        needs_details: bool,
        needs_chapters: bool,
    ) -> Result<Manga> {
        if needs_details {
            let manga_url = manga
                .url
                .clone()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| aidoku::imports::error::AidokuError::message("Falta la URL del manga"))?;

            let document = Self::request_headers(Request::get(manga_url)?).html()?;

            if let Some(title) = document
                .select_first("div.col-md-9 h1, h1")
                .and_then(|item| item.text())
                .filter(|value| !value.is_empty())
            {
                manga.title = title;
            }

            manga.cover = document
                .select_first("div.col-md-3 div.panel.widget img")
                .and_then(|item| item.attr("abs:src"))
                .or(manga.cover);

            manga.description = document
                .select_first("div.col-md-9 div.panel-body")
                .and_then(|item| item.text())
                .filter(|value| !value.is_empty());

            if let Some(status) = document
                .select_first("a.list-group-item:contains(estado) span")
                .and_then(|item| item.text())
            {
                manga.status = Self::parse_status(&status);
            }

            manga.content_rating = ContentRating::Safe;
        }

        if needs_chapters {
            manga.chapters = Some(Self::chapter_list(&manga.key)?);
        }

        Ok(manga)
    }

    fn get_page_list(&self, manga: Manga, chapter: Chapter) -> Result<Vec<Page>> {
        let chapter_url = chapter
            .url
            .clone()
            .unwrap_or_else(|| {
                format!(
                    "{BASE_URL}/chapter/chapterIndexControls?identification={}",
                    chapter.key
                )
            });

        let document = Self::request_headers(Request::get(chapter_url)?).html()?;

        let chapter_id = document
            .select_first("input#ChapterIdentification")
            .and_then(|item| item.attr("value"))
            .filter(|value| !value.is_empty())
            .unwrap_or(chapter.key);

        let manga_id = document
            .select_first("input#MangaIdentification")
            .and_then(|item| item.attr("value"))
            .filter(|value| !value.is_empty())
            .unwrap_or(manga.key);

        let mut pages = Vec::new();

        if let Some(images) = document.select("img.ImageContainer") {
            for image in images {
                let image_id = image.attr("id").unwrap_or_default();

                let url = if !image_id.is_empty() {
                    format!("{IMAGE_CDN}/i/m/{manga_id}/c/{chapter_id}/o/{image_id}.jpg")
                } else {
                    image
                        .attr("abs:src")
                        .or_else(|| image.attr("abs:data-src"))
                        .unwrap_or_default()
                };

                if url.is_empty() {
                    continue;
                }

                pages.push(Page {
                    content: PageContent::url(url),
                    ..Default::default()
                });
            }
        }

        if pages.is_empty() {
            bail!("InManga no devolvió páginas para este capítulo.");
        }

        Ok(pages)
    }
}

impl ListingProvider for InManga {
    fn get_manga_list(&self, listing: Listing, page: i32) -> Result<MangaPageResult> {
        match listing.id.as_str() {
            "popular" => Self::manga_list(page, "", 1),
            "latest" => Self::manga_list(page, "", 3),
            _ => bail!("Listado no compatible"),
        }
    }
}

impl ImageRequestProvider for InManga {
    fn get_image_request(&self, url: String, _context: Option<PageContext>) -> Result<Request> {
        Ok(Request::get(url)?
            .header("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
            .header("Accept-Language", "es-CL,es;q=0.9,en;q=0.8")
            .header("Referer", "https://inmanga.com/")
            .header(
                "User-Agent",
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
            ))
    }
}

register_source!(InManga, ListingProvider, ImageRequestProvider);
