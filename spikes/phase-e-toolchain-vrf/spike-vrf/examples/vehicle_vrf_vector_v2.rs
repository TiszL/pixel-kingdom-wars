//! Explicit local generator; never updates fixtures during tests.
#[path = "../tests/support/vehicle_vector_v2.rs"]
mod vector;
fn main() {
    print!("{}", vector::json());
}
