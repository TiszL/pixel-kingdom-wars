//! Explicit local generator; never updates fixtures during tests.
#[path = "../tests/support/vehicle_vector.rs"]
mod vector;
fn main() {
    print!("{}", vector::json());
}
