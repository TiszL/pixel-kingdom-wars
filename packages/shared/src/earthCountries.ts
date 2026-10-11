/**
 * GENERATED FILE — DO NOT EDIT. Regenerate with:
 *   pnpm --filter @shardkeep/scripts earth:mask
 * Generator: scripts/src/earth-mask.ts (records the full method + rationale).
 *
 * EARTH_COUNTRIES: which country owns each land cell of the 180×90 (2.00°) mask.
 * ONE BYTE PER LAND CELL, in `landCellList()` order (ascending row-major over the
 * mask's land cells) — NOT one byte per grid cell. 0 = no sovereign; 1..176 index
 * `countries`, which is sorted by ADM0_A3 so a data refresh cannot renumber tiles.
 * 5432 land cells, 176 countries, 1529 cells with no sovereign
 * (28.1% — ATA: dropped, therefore NOT claimable Earth).
 *
 * The union of these country rings rasterises to the checked-in land mask
 * BYTE-IDENTICALLY (the generator throws otherwise), so every land cell that is
 * not dropped has a country BY CONSTRUCTION rather than nearly always.
 *
 * 35 SUB-TILE COUNTRIES, each smaller than one cell and each granted exactly one
 * tile so that no country is missing from Earth (owner decision 2026-08-10, Q4b).
 * The tile is the cell where the country IS: the cell it polls strongest in, or
 * for a country too small to be sampled at all, the cell holding the centroid of
 * its largest ring. 18 of those cells are ones the majority rule counts as
 * OCEAN (Barbados is 431 km² against a ~3,090 km² cell), and they are carried in
 * `extraCells` instead of being stolen from a mainland neighbour — so no country's
 * tile ever lands inside a different country's territory. CLAIMABLE EARTH is
 * therefore "land cells with a country" PLUS `extraCells`. Enumerated here so the
 * list is reviewable, and asserted one-by-one in earthMask.test.ts:
 *   ALB Albania — its own cell, extra (the mask sees ocean here)
 *   ATF Fr. S. Antarctic Lands — its own cell, extra (the mask sees ocean here)
 *   BDI Burundi — its own cell, taken from COD
 *   BHS Bahamas — its own cell, extra (the mask sees ocean here)
 *   BLZ Belize — its own cell, taken from GTM
 *   BRN Brunei — its own cell, taken from MYS
 *   BTN Bhutan — its own cell, taken from IND
 *   CYN N. Cyprus — its own cell, extra (the mask sees ocean here)
 *   CYP Cyprus — shares an island, took the nearest free cell, taken from TUR
 *   DJI Djibouti — its own cell, taken from SOL
 *   FJI Fiji — its own cell, extra (the mask sees ocean here)
 *   FLK Falkland Is. — its own cell, extra (the mask sees ocean here)
 *   GMB Gambia — its own cell, extra (the mask sees ocean here)
 *   GNB Guinea-Bissau — its own cell, taken from GIN
 *   GNQ Eq. Guinea — its own cell, taken from GAB
 *   JAM Jamaica — its own cell, extra (the mask sees ocean here)
 *   KOS Kosovo — its own cell, taken from SRB
 *   KWT Kuwait — its own cell, taken from SAU
 *   LBN Lebanon — its own cell, extra (the mask sees ocean here)
 *   LSO Lesotho — its own cell, taken from ZAF
 *   LUX Luxembourg — its own cell, taken from FRA
 *   MNE Montenegro — its own cell, taken from BIH
 *   NCL New Caledonia — its own cell, extra (the mask sees ocean here)
 *   PAN Panama — its own cell, extra (the mask sees ocean here)
 *   PRI Puerto Rico — its own cell, extra (the mask sees ocean here)
 *   PSX Palestine — shares an island, took the nearest free cell, extra (the mask sees ocean here)
 *   QAT Qatar — its own cell, taken from SAU
 *   RWA Rwanda — its own cell, taken from UGA
 *   SLB Solomon Is. — its own cell, extra (the mask sees ocean here)
 *   SLV El Salvador — its own cell, extra (the mask sees ocean here)
 *   SVN Slovenia — its own cell, taken from AUT
 *   SWZ eSwatini — its own cell, taken from ZAF
 *   TLS Timor-Leste — its own cell, extra (the mask sees ocean here)
 *   TTO Trinidad and Tobago — its own cell, extra (the mask sees ocean here)
 *   VUT Vanuatu — its own cell, extra (the mask sees ocean here)
 *
 * SOURCE: https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/cultural/ne_110m_admin_0_countries.json
 * LICENSE: Natural Earth vector data is PUBLIC DOMAIN
 * (https://www.naturalearthdata.com/about/terms-of-use/); the GeoJSON
 * conversion is CC0-1.0. No attribution required; recorded here anyway.
 * DISCLAIMER TO SHIP WITH ANY VISIBLE COUNTRY NAME, from Natural Earth itself:
 * "Natural Earth Vector draws boundaries of countries according to de facto
 * status." No boundary is redrawn or merged here, and no flags are emitted.
 *
 * LOADED EAGERLY, BUT NOT FROM index.ts — subpath '@shardkeep/shared/earthCountries'
 * only, for the same reason as earthMask.ts (packages/sim imports the barrel).
 */
import type { CountryIndex } from './globe';

const PACKED =
  'GxsbGxsbGxsbQUFBQUFBQUFBQRsbGxsbGxsbGxsbGxsbQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUGHhxsbGxsbGxsbG0FB' +
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF2dnZ2h4eHh4cbGxsbGxsbQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQYeHhxsbGxsb' +
  'GxsbGxsbG0FBQUFBQUFBQUFBQUFBQUFBQUGHh4eHh4eHh4eHh4eHh4eHhxsbGxsbGxsbGxsbGxsbGxtBQUFBQUFBQUFBQUFB' +
  'QUFBQYeHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHqKgbGxsbGxsbGxsbGxsbGxsbGxsbQUFBQUFBQUFBQUFBQUFBQXZ2' +
  'doeHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh6ioqKioqKioqKioqKgbGxsbGxsbGxsbGxsb' +
  'GxsbGxsbGxsbGxsbGxtBQUFBQUFBQUFBQUFBdnZ2djSHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eH' +
  'h4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHqKioqKioqKioqKgbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsb' +
  'GxtBQUFBQUFBQUFBdpeXl5c0NDSHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eH' +
  'h4eHh4eHh4eHh4eHh4eHh4eHh4eHh6ioqKioqKioqKioqBsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxtBQUFB' +
  'QUFNTU1NdpeXl5c0NDSHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eH' +
  'h4eHh4eHh4eHh4eHh4eHqKioqKioqKioqKgbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbQUFBQXZ2l5eXNDQ0NIeHh4eH' +
  'h4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHqKio' +
  'qKioqKioqKioqBsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbG0FBQXZ2dnaXl5c0NDQ0h4eHh4eHh4eHh4eHh4eHh4eHh4eH' +
  'h4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHqKioqKioqBsbGxsbGxsbGxsbGxsbGxsb' +
  'GxsbGxsbGxsbdnZ2l5eXMjKHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eH' +
  'h4eHh4eoGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGzk5K5eXYmJih4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eH' +
  'h4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh6gbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxs5OSt/YGATE4eH' +
  'h4eHh4eHh4eHh4eHh4eHh4dTh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHGxsbGxsbGxsbGxsbGxsbGxsb' +
  'GxsbGxsbGxsbGxsbGxsbG0pKOTl1KSkpKX9/f39/ExMTE4eHh4eHh4eHh4eHh4eHU1NTU1NTU1NTh4eHh4eHh4eHh4eHh4eH' +
  'h4eHh4eHHh4eh4eHh4eHh4eHh4cbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxs5OTcMKSkpKSh/f39/pqam' +
  'pqamh4eHh4eHh1NTh1OHU1NTU1NTU1NTU1NTh4eHh4eHh2trh4eHh4eHh4eHHh4eHoeHh4eHh4cbGxsbGxsbGxsbGxsbGxsb' +
  'GxsbGxsbGxsbGxsbGxsbGzc3N2EpKSkpKCiVlaampqampqampoeHh1NTU1NTU1NTU1NTU1NTU1NTU1NTHmtra2tra2tra2tr' +
  'a2trHh4eHh4eHoeHh4eHh6ioqKioqKioqKioqKioqKioqKgbGxsbGxsbG6gbGzc3NzccHE8JlkdHR4aGhmSmpqamh4eHh4dT' +
  'U1NTU1NTU1NTU1NTU1NTU1MeHh5ra2tra2tra2tra2trax4eHh4eHh4eh4eoqKioqKioqKioqKioqKioqKioqKgbGxsbG6io' +
  'GxsbNzc3NzdPT09FRRKThoaGhoeHh4eHh1NTqalTU1NTU1NTU1NTHh4eHh4eHmtra2tra2trax4eHh4eHh4eHh6Hh6ioqKio' +
  'qKioqKioqKioqKioqKioqBsbqKioqDExMTE3N09PalgQEBA6h4eHU1OpqampqVNTU1NVU1MeHh4eHh4eHmtra2tra2seHh4e' +
  'Hh4eHh4eh1JSqKioqKioqKioqKioqKioqKioqKioqKioqKiCgjExMTFPT2dAEKKioqKioqKiogYKCp6enp6pqalTqVVVVR4e' +
  'Hh4eHh4eHh4eHh4eHh4eHh4eHh4eHoGBUqioqKioqKioqKioqKioqKioqKioqKioqKiCMTExMUBAoqKioqKioqKiS0sKnp6e' +
  'np6pqZ2dnR4eHh4eHh4eHh4eHh4eHh4eHh4eHh6BgVKoqKioqKioqKioqKioqKioqKioqKioqDExMS2hoieioqKiokxLS0tL' +
  'S0tLnp6eAQEBenoeHh4eHh4eHh4eHh4eHh4eHh4eHh4eHldXUlKoqKioqKioqKioqKioqKioqKioqKioY2MtLS0tLaGZmZlM' +
  'TEtLS0tLS0sBAQEBAQF6ekkeHh4eHh4eHh4eHh4eHh4eHh4eHh5XUlJSUqioqKioqKioqKioqKioqKioqKhjY2MtLS0tLaGh' +
  'mUxMTExLS0tLS0tLAQEBAQF6eklJHh4eHh4eHh4eHh4eHh4eHh4eHh4eUmZmZmZmqKioqKioqKioqKioY2NjLS0tLS0tLV1d' +
  'XV1dXV0vLy8vTlGKikxMTEtLS0tLS0sBAQF6enpJSUkeHh4eHh4eHh4eHh4eHh4eHh4eHh5mZmZmZmaoqKioYy0tLS0tLS0t' +
  'LV1dXV1dXV0vLy8vL4qKioqKillLS0tLS0t6enp6eklJSUl3dx4eHh4eHh4eHh4eHh4eHh4eHh5mZmZmZmaoqGNjiS0tLS0t' +
  'LS0tLV1dXV1dXV0vLy8vL4qKioqKiopLS0tLenp6eklJSUlJSUl3d0kYSUlpHh4eHh4eHh4eHh5mZmZmZmZjY21tbS0tLS0t' +
  'LS0tXV1dXV1dXS8vLy8vioqKioqKioUEenp6SUlJSUlJSUlJDw9JaWkeHh4eHh4eHh4eZmZmZiVjiW1tbWhoLS0tLS0tLXJd' +
  'XV1dXS8vLy8vL4qKioqKiooEBHl5SUlJSUlJSUlJSQ8PSWlpaR4eqx4eHh4eo2ZmZmZmJW1tbW1taGhoaC0tLXJycnKaml1d' +
  'XYuLi4uLi4qKioqKioqKeUlJSUlJSUlJSWlpaWlaWqurZmZmZmZmRixtbW1tbWhoaGhocnJycnJympqamouLi4uLi4uKioqK' +
  'iop5eXlJSUlJSUlpaZxaWqseZmZmZkIUbW1tbW1oaGhoaHJycnJycpqampqLi4uLi4uLiq2tra15SUlJSWlpnJycWqt9QkJE' +
  'RI2NjWhoaGhoaGhycnJycnKampqai4uLi4uLizAwra2trUlJSZycnJxafXR0jY1oaGhoDg4OcnNzcnNzmpqamouLi4uLi4sz' +
  'MzOtrUlJSZycVlZWq3Qjqqo+PDw8aA4ODg4Nc3Nzc3Mgmpqai4uLi4uLMzMzMyqRkUlJnFarJCMjqqqqqqqqj488Hx8fO5sN' +
  'c3NzcyCampoaGoyMjIyMMzMzMzORkZJJnH0jIyMjqqqqqqpDXFwfHx87m3Nzc3NzICAaGhoaGoyMjIwzMzMzMzOSkl6cfSMj' +
  'IyMjqqqqFkOUlDdcHx8fcyAgIBoaGhoaGiGMjIxUMzMzM5KSSG9vF28jIyMjI6qqFhZDlJQ3FiAgICIhISEhISEhpVRUVFSS' +
  'kkhvb29ILiMjIyMWFhYWFhYWFhYWPzgiIiEhISEhIaWlVFRUVJJISEhISEhILi58IyMWFhYWFhYWFhYWFhY4ODgiIiEhISEh' +
  'IYikVFRUVEhISEhISEhILnx8fHwWFhYWFhYWFhYWFhYWFhY4IiIhISEhISELpKSkpFRISEhISEhISEhISHx8fHx8FhYWFhYW' +
  'FhYWFhYWFhYWFhYWISEhISEhISEhpKSkpKRISEhIfn58fHwWFhYWFhYWFhYWFhYWFhYWFhYWFgICISEhISEhIaSkpKSkSEhI' +
  'SH5+fnx8FhYWFhYWFhYWFhYWFhYWFhYWFgICAgICISEhr6+kpKSkfn58fHx8FhUWFhYWFhYWFhYWFhYWFhYCAgICAiEhr6+v' +
  'pKRsfHx8FRUVFRYWFhYWFhYWFhYWFgICAgICAq+vr6+vbGxsZQgICAh8fHwVFRUVFRYWFhYWFhYWFhYWAgICAgKvr6+vbGxu' +
  'bGxlCAgICAgICAh8FRUVFRUVFhYWFhYWFhYWFgICAgICr6+vsLBsbGxlZWUICAgICAgICAgICB0VFRUVFRYWFhYWFhYWFnBw' +
  'cHAZGRmwsLBsbGVlZQgICAgICAgICAgICB0VFRWDgxYWFhYWFhYWFnBwcBkZGRmwsGxsZWUICAgICAgICAgICAgICAgICB0F' +
  'BQWDg4MWFhYWFhYWcHBwGRkZGa6ubGxlZQgICAgICAgICAgICAgICAgICB0FBQUFBYODFhYWcHBwGRkZrq6ubGUICAgICAgI' +
  'CAgICAgICAgICAgIHR0FBQUFBYMFFhYWcHCurq6urpgICAgICAgICAgICAgICAgICAgICB0FBQUFBQUFFhYWrq6urq6uX64I' +
  'CAgICAgICAgICAgICAgICAgICB0FBQUFBQWnFhYWrq6urq6uCAgICAgICAgICAgICAgICAgICB0FBQUFBQWnp6eurq6urggI' +
  'CAgICAgICAgICAgdBQUFBQUFCAgICAgICB0dBQUFBQUFCAgICAh4HQUFBQUFBXh4HQUFBQUIeB0FBQUFCHh4HQUFBXh4HQUF' +
  'BR0FBQUFHR0FBR0dHR0FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// a3|iso2|a3is|a3un|a3us|color|name, one row per country, ADM0_A3 order.
// ISO_A2 and the alternate-viewpoint codes are '' where Natural Earth says −99.
const TABLE =
  'AFG|AF|AFG||AFG|8|Afghanistan\nAGO|AO|AGO||AGO|6|Angola\nALB|AL|ALB||ALB|1|Albania\nARE|AE|ARE||ARE|3|United Arab Emirates\n' +
  'ARG|AR|ARG||ARG|3|Argentina\nARM|AM|ARM||ARM|2|Armenia\nATF|TF|ATF||ATF|9|Fr. S. Antarctic Lands\nAUS|AU|AUS||AUS|2|Australia\n' +
  'AUT|AT|AUT||AUT|3|Austria\nAZE|AZ|AZE||AZE|5|Azerbaijan\nBDI|BI|BDI||BDI|5|Burundi\nBEL|BE|BEL||BEL|1|Belgium\n' +
  'BEN|BJ|BEN||BEN|2|Benin\nBFA|BF|BFA||BFA|5|Burkina Faso\nBGD|BD|BGD||BGD|7|Bangladesh\nBGR|BG|BGR||BGR|1|Bulgaria\n' +
  'BHS|BS|BHS||BHS|2|Bahamas\nBIH|BA|BIH||BIH|1|Bosnia and Herz.\nBLR|BY|BLR||BLR|5|Belarus\nBLZ|BZ|BLZ||BLZ|5|Belize\n' +
  'BOL|BO|BOL||BOL|2|Bolivia\nBRA|BR|BRA||BRA|5|Brazil\nBRN|BN|BRN||BRN|6|Brunei\nBTN|BT|BTN||BTN|1|Bhutan\n' +
  'BWA|BW|BWA||BWA|7|Botswana\nCAF|CF|CAF||CAF|6|Central African Rep.\nCAN|CA|CAN||CAN|2|Canada\nCHE|CH|CHE||CHE|7|Switzerland\n' +
  'CHL|CL|CHL||CHL|5|Chile\nCHN|CN|CHN||CHN|4|China\nCIV|CI|CIV||CIV|3|Côte d\'Ivoire\nCMR|CM|CMR||CMR|1|Cameroon\n' +
  'COD|CD|COD||COD|4|Dem. Rep. Congo\nCOG|CG|COG||COG|3|Congo\nCOL|CO|COL||COL|3|Colombia\nCRI|CR|CRI||CRI|4|Costa Rica\n' +
  'CUB|CU|CUB||CUB|3|Cuba\nCYN||CYP||CYP|4|N. Cyprus\nCYP|CY|CYP||CYP|3|Cyprus\nCZE|CZ|CZE||CZE|2|Czechia\n' +
  'DEU|DE|DEU||DEU|5|Germany\nDJI|DJ|DJI||DJI|4|Djibouti\nDNK|DK|DNK||DNK|3|Denmark\nDOM|DO|DOM||DOM|5|Dominican Rep.\n' +
  'DZA|DZ|DZA||DZA|6|Algeria\nECU|EC|ECU||ECU|2|Ecuador\nEGY|EG|EGY||EGY|7|Egypt\nERI|ER|ERI||ERI|2|Eritrea\n' +
  'ESP|ES|ESP||ESP|5|Spain\nEST|EE|EST||EST|1|Estonia\nETH|ET|ETH||ETH|1|Ethiopia\nFIN|FI|FIN||FIN|4|Finland\n' +
  'FJI|FJ|FJI||FJI|2|Fiji\nFLK|FK|FLK||FLK|6|Falkland Is.\nFRA||FRA||FRA|9|France\nGAB|GA|GAB||GAB|5|Gabon\n' +
  'GBR|GB|GBR||GBR|6|United Kingdom\nGEO|GE|GEO||GEO|3|Georgia\nGHA|GH|GHA||GHA|1|Ghana\nGIN|GN|GIN||GIN|7|Guinea\n' +
  'GMB|GM|GMB||GMB|1|Gambia\nGNB|GW|GNB||GNB|3|Guinea-Bissau\nGNQ|GQ|GNQ||GNQ|4|Eq. Guinea\nGRC|GR|GRC||GRC|2|Greece\n' +
  'GRL|GL|GRL||GRL|3|Greenland\nGTM|GT|GTM||GTM|3|Guatemala\nGUY|GY|GUY||GUY|4|Guyana\nHND|HN|HND||HND|2|Honduras\n' +
  'HRV|HR|HRV||HRV|5|Croatia\nHTI|HT|HTI||HTI|7|Haiti\nHUN|HU|HUN||HUN|1|Hungary\nIDN|ID|IDN||IDN|6|Indonesia\n' +
  'IND|IN|IND||IND|2|India\nIRL|IE|IRL||IRL|2|Ireland\nIRN|IR|IRN||IRN|4|Iran\nIRQ|IQ|IRQ||IRQ|3|Iraq\n' +
  'ISL|IS|ISL||ISL|4|Iceland\nISR|IL|ISR||ISR|5|Israel\nITA|IT|ITA||ITA|8|Italy\nJAM|JM|JAM||JAM|4|Jamaica\n' +
  'JOR|JO|JOR||JOR|4|Jordan\nJPN|JP|JPN||JPN|5|Japan\nKAZ|KZ|KAZ||KAZ|6|Kazakhstan\nKEN|KE|KEN||KEN|7|Kenya\n' +
  'KGZ|KG|KGZ||KGZ|7|Kyrgyzstan\nKHM|KH|KHM||KHM|6|Cambodia\nKOR|KR|KOR||KOR|1|South Korea\nKOS|XK|KOS||KOS|3|Kosovo\n' +
  'KWT|KW|KWT||KWT|2|Kuwait\nLAO|LA|LAO||LAO|1|Laos\nLBN|LB|LBN||LBN|4|Lebanon\nLBR|LR|LBR||LBR|4|Liberia\n' +
  'LBY|LY|LBY||LBY|2|Libya\nLKA|LK|LKA||LKA|4|Sri Lanka\nLSO|LS|LSO||LSO|2|Lesotho\nLTU|LT|LTU||LTU|3|Lithuania\n' +
  'LUX|LU|LUX||LUX|3|Luxembourg\nLVA|LV|LVA||LVA|6|Latvia\nMAR|MA|MAR||MAR|3|Morocco\nMDA|MD|MDA||MDA|4|Moldova\n' +
  'MDG|MG|MDG||MDG|2|Madagascar\nMEX|MX|MEX||MEX|7|Mexico\nMKD|MK|MKD||MKD|7|North Macedonia\nMLI|ML|MLI||MLI|1|Mali\n' +
  'MMR|MM|MMR||MMR|5|Myanmar\nMNE|ME|MNE||MNE|4|Montenegro\nMNG|MN|MNG||MNG|5|Mongolia\nMOZ|MZ|MOZ||MOZ|1|Mozambique\n' +
  'MRT|MR|MRT||MRT|2|Mauritania\nMWI|MW|MWI||MWI|4|Malawi\nMYS|MY|MYS||MYS|3|Malaysia\nNAM|NA|NAM||NAM|1|Namibia\n' +
  'NCL|NC|NCL||NCL|9|New Caledonia\nNER|NE|NER||NER|3|Niger\nNGA|NG|NGA||NGA|5|Nigeria\nNIC|NI|NIC||NIC|1|Nicaragua\n' +
  'NLD|NL|NLD||NLD|2|Netherlands\nNOR||NOR||NOR|8|Norway\nNPL|NP|NPL||NPL|3|Nepal\nNZL|NZ|NZL||NZL|4|New Zealand\n' +
  'OMN|OM|OMN||OMN|1|Oman\nPAK|PK|PAK||PAK|3|Pakistan\nPAN|PA|PAN||PAN|6|Panama\nPER|PE|PER||PER|4|Peru\n' +
  'PHL|PH|PHL||PHL|2|Philippines\nPNG|PG|PNG||PNG|3|Papua New Guinea\nPOL|PL|POL||POL|1|Poland\nPRI|PR|PRI||PRI|1|Puerto Rico\n' +
  'PRK|KP|PRK||PRK|3|North Korea\nPRT|PT|PRT||PRT|1|Portugal\nPRY|PY|PRY||PRY|6|Paraguay\nPSX|PS|PSE||PSX|5|Palestine\n' +
  'QAT|QA|QAT||QAT|2|Qatar\nROU|RO|ROU||ROU|3|Romania\nRUS|RU|RUS||RUS|7|Russia\nRWA|RW|RWA||RWA|3|Rwanda\n' +
  'SAH|EH|MAR||SAH|4|W. Sahara\nSAU|SA|SAU||SAU|6|Saudi Arabia\nSDN|SD|SDN||SDN|4|Sudan\nSDS|SS|SSD||SDS|3|S. Sudan\n' +
  'SEN|SN|SEN||SEN|5|Senegal\nSLB|SB|SLB||SLB|1|Solomon Is.\nSLE|SL|SLE||SLE|1|Sierra Leone\nSLV|SV|SLV||SLV|6|El Salvador\n' +
  'SOL||SOM||SOM|5|Somaliland\nSOM|SO|SOM||SOM|6|Somalia\nSRB|RS|SRB||SRB|2|Serbia\nSUR|SR|SUR||SUR|7|Suriname\n' +
  'SVK|SK|SVK||SVK|4|Slovakia\nSVN|SI|SVN||SVN|2|Slovenia\nSWE|SE|SWE||SWE|2|Sweden\nSWZ|SZ|SWZ||SWZ|2|eSwatini\n' +
  'SYR|SY|SYR||SYR|2|Syria\nTCD|TD|TCD||TCD|8|Chad\nTGO|TG|TGO||TGO|3|Togo\nTHA|TH|THA||THA|8|Thailand\n' +
  'TJK|TJ|TJK||TJK|2|Tajikistan\nTKM|TM|TKM||TKM|1|Turkmenistan\nTLS|TL|TLS||TLS|4|Timor-Leste\nTTO|TT|TTO||TTO|2|Trinidad and Tobago\n' +
  'TUN|TN|TUN||TUN|3|Tunisia\nTUR|TR|TUR||TUR|8|Turkey\nTWN|TW|TWN||TWN|7|Taiwan\nTZA|TZ|TZA||TZA|2|Tanzania\n' +
  'UGA|UG|UGA||UGA|6|Uganda\nUKR|UA|UKR||UKR|6|Ukraine\nURY|UY|URY||URY|2|Uruguay\nUSA|US|USA||USA|1|United States of America\n' +
  'UZB|UZ|UZB||UZB|5|Uzbekistan\nVEN|VE|VEN||VEN|1|Venezuela\nVNM|VN|VNM||VNM|5|Vietnam\nVUT|VU|VUT||VUT|7|Vanuatu\n' +
  'YEM|YE|YEM||YEM|3|Yemen\nZAF|ZA|ZAF||ZAF|4|South Africa\nZMB|ZM|ZMB||ZMB|5|Zambia\nZWE|ZW|ZWE||ZWE|3|Zimbabwe';

// cell:countryId for the 18 sub-tile countries whose own cell the mask counts as
// ocean. Ascending by cell, so a lookup is a binary search.
const EXTRA = '4419:3,4966:38,5146:132,5147:91,5630:17,6351:80,6356:128,6885:144,6921:61,7079:160,7249:123,8972:159,8990:142,9533:172,9719:53,10072:113,12544:7,12660:54';

// Base64 decoded by hand rather than with atob/Buffer: this module is imported
// by the browser bundle, the Fastify server AND vitest, and `atob` is a global
// that packages/shared does not declare in its `lib`. 12 lines removes the
// environment assumption entirely.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function unpack(s: string): Uint8Array {
  const pad = s.indexOf('=');
  const n = pad < 0 ? s.length : pad;
  const out = new Uint8Array((n * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < n; i++) {
    acc = (acc << 6) | B64.indexOf(s[i]!);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out;
}

const extraPairs = EXTRA ? EXTRA.split(',').map((p) => p.split(':').map(Number)) : [];

export const EARTH_COUNTRIES: CountryIndex = {
  cols: 180,
  rows: 90,
  cells: unpack(PACKED),
  extraCells: Int32Array.from(extraPairs, (p) => p[0]!),
  extraIds: Uint8Array.from(extraPairs, (p) => p[1]!),
  countries: TABLE.split('\n').map((row) => {
    const p = row.split('|');
    return {
      a3: p[0]!,
      iso2: p[1]!,
      a3is: p[2]!,
      a3un: p[3]!,
      a3us: p[4]!,
      color: Number(p[5]!),
      name: p[6]!,
    };
  }),
};
