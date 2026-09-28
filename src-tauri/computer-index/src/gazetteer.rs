use std::sync::OnceLock;

#[derive(Debug)]
pub struct City {
    pub id: &'static str,
    pub ascii: &'static str,
    pub lat: f64,
    pub lon: f64,
}

pub fn cities() -> &'static [City] {
    static CITIES: OnceLock<Vec<City>> = OnceLock::new();
    CITIES.get_or_init(|| {
        include_str!("../data/cities.tsv")
            .lines()
            .filter_map(|line| {
                let mut f = line.split('\t');
                let id = f.next()?;
                let _name = f.next()?;
                Some(City {
                    id,
                    ascii: f.next()?,
                    lat: f.next()?.parse().ok()?,
                    lon: f.next()?.parse().ok()?,
                })
            })
            .collect()
    })
}

pub fn nearest(lat: f64, lon: f64) -> Option<&'static City> {
    let distance = |c: &City| {
        let dlat = (c.lat - lat).to_radians();
        let dlon = (c.lon - lon).to_radians();
        let a = (dlat / 2.0).sin().powi(2)
            + lat.to_radians().cos() * c.lat.to_radians().cos() * (dlon / 2.0).sin().powi(2);
        6371.0 * 2.0 * a.sqrt().min(1.0).asin()
    };
    cities()
        .iter()
        .min_by(|a, b| distance(a).total_cmp(&distance(b)))
        .filter(|c| distance(c) <= 100.0)
}
