// ============================================================
// Mavero TV — self-contained JSON codec (SimpleJson.cs).
//
// WHY THIS EXISTS (field-TV crash hardening, v0.0.4):
//   The tpk bin/ previously shipped Newtonsoft.Json.dll next to
//   MaveroTv.dll. On the real TV the process died BEFORE Program.Main
//   (OS splash, no managed handler ever ran) — one proven-possible
//   cause is a dependent-assembly load failure inside the TV's mono
//   launcher (netstandard facades the TV host policy does not
//   resolve, stale assembly versions, etc.). Removing every
//   third-party NuGet DLL makes bin/ carry ONLY MaveroTv.dll — there
//   is then NOTHING left that can fail assembly resolution at boot.
//
// Surface (deliberately Newtonsoft-compatible so Models.cs and the
// call sites keep their shape):
//   - [JsonProperty("wire-name")]  — key mapping attribute;
//   - JsonConvert.SerializeObject(obj) — POCOs, Dictionary<,>,
//     List<T>, arrays, primitives;
//   - JsonConvert.DeserializeObject<T>(json) — reflection mapper for
//     the same type family (object/bool/string/int/long/double/
//     float/decimal + nullables + enums, List<T>, T[], string[],
//     Dictionary<string, string|object>, POCOs with public setters).
//
// Parsing contract (hand-rolled recursive descent, zero BCL extras):
//   DOM nodes are Dictionary<string,object> / List<object> / string /
//   long-or-double / bool / null. Numbers parse as long when integral,
//   double otherwise (invariant culture). \uXXXX escapes are decoded;
//   every string is plain UTF-8 — the app targets only its own
//   provider APIs, so exotic options (dates, references, converters)
//   are intentionally absent. Malformed input throws FormatException
//   with the byte offset — callers wrap it defensively.
//
// Not thread-hostile: Parse/Map/SWrite are pure functions over their
// inputs; every ApiService/AuthSession call site already serializes
// under its own locks or on immutable snapshots.
// ============================================================
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Text;

namespace MaveroTv
{
    /// <summary>
    /// Newtonsoft-compatible key-mapping attribute: binds a C# property
    /// to its JSON wire name. Kept in MaveroTv's own namespace so the
    /// model classes need no external package.
    /// </summary>
    [AttributeUsage(AttributeTargets.Property | AttributeTargets.Field)]
    public sealed class JsonPropertyAttribute : Attribute
    {
        /// <summary>The JSON key on the wire (null = use the member name).</summary>
        public string Name { get; private set; }

        /// <summary>Null emission policy — Ignore omits null-valued properties
        /// from the payload (wire-correctness requirement of ContentSnapshot:</summary>
        public NullValueHandling NullValueHandling { get; set; }

        public JsonPropertyAttribute()
        {
        }

        public JsonPropertyAttribute(string name)
        {
            Name = name;
        }
    }

    /// <summary>Compat enum for JsonPropertyAttribute.NullValueHandling.</summary>
    public enum NullValueHandling
    {
        Include = 0,
        Ignore = 1
    }

    /// <summary>Newtonsoft-compatible opt-out: a member marked with this is
    /// never serialized or populated (client-side-only fields).</summary>
    [AttributeUsage(AttributeTargets.Property | AttributeTargets.Field)]
    public sealed class JsonIgnoreAttribute : Attribute
    {
    }

    /// <summary>
    /// Minimal JSON serializer/deserializer — the ONLY JSON code in the
    /// app (Newtonsoft.Json was removed from the tpk payload, see the
    /// file header). Same call surface as the old dependency:
    /// JsonConvert.SerializeObject / DeserializeObject&lt;T&gt;.
    /// </summary>
    public static class JsonConvert
    {
        // ---- parse -------------------------------------------------------

        /// <summary>Deserializes `json` into a new T (POCO, list, array or dictionary).</summary>
        public static T DeserializeObject<T>(string json)
        {
            return (T)DeserializeObject(json, typeof(T));
        }

        /// <summary>Untyped variant for the Dictionary&lt;string, object&gt; callers.</summary>
        public static object DeserializeObject(string json, Type type)
        {
            object node = Parse(json);
            return Map(node, type);
        }

        // ---- serialize -----------------------------------------------------

        /// <summary>Serializes any supported value (POCO / IDictionary / IEnumerable / primitive).</summary>
        public static string SerializeObject(object value)
        {
            StringBuilder sb = new StringBuilder(256);
            WriteValue(sb, value);
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object value)
        {
            if (value == null)
            {
                sb.Append("null");
                return;
            }

            if (value is string)
            {
                WriteString(sb, (string)value);
                return;
            }

            if (value is bool)
            {
                sb.Append((bool)value ? "true" : "false");
                return;
            }

            if (value is char)
            {
                WriteString(sb, value.ToString());
                return;
            }

            // All numeric types (int, long, double, float, decimal, short,
            // byte...) share IFormattable — invariant culture, no rounding.
            IFormattable number = value as IFormattable;
            if (number != null && !(value is DateTime) && !(value is DateTimeOffset))
            {
                sb.Append(number.ToString(null, CultureInfo.InvariantCulture));
                return;
            }

            IDictionary dict = value as IDictionary;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (DictionaryEntry entry in dict)
                {
                    if (!first)
                    {
                        sb.Append(',');
                    }
                    first = false;
                    WriteString(sb, Convert.ToString(entry.Key, CultureInfo.InvariantCulture));
                    sb.Append(':');
                    WriteValue(sb, entry.Value);
                }
                sb.Append('}');
                return;
            }

            IEnumerable list = value as IEnumerable;
            if (list != null)
            {
                sb.Append('[');
                bool firstItem = true;
                foreach (object item in list)
                {
                    if (!firstItem)
                    {
                        sb.Append(',');
                    }
                    firstItem = false;
                    WriteValue(sb, item);
                }
                sb.Append(']');
                return;
            }

            // POCO: every public instance readable property (indexers excluded).
            PropertyInfo[] props = value.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance);
            sb.Append('{');
            bool wroteAny = false;
            for (int i = 0; i < props.Length; i++)
            {
                PropertyInfo prop = props[i];
                if (prop.GetIndexParameters().Length > 0 || !prop.CanRead || IsJsonIgnored(prop))
                {
                    continue;
                }

                object propValue;
                try
                {
                    propValue = prop.GetValue(value, null);
                }
                catch (Exception)
                {
                    propValue = null;
                }

                // NullValueHandling.Ignore: omit null-valued properties from
                // the payload — the favorites validator treats PRESENT-but-null
                // fields as invalid records (see ContentSnapshot).
                if (propValue == null && IgnoresNull(prop))
                {
                    continue;
                }

                if (wroteAny)
                {
                    sb.Append(',');
                }
                wroteAny = true;

                sb.Append('"').Append(WireName(prop)).Append('"');
                sb.Append(':');
                WriteValue(sb, propValue);
            }
            sb.Append('}');
        }

        /// <summary>True when the property carries [JsonIgnore].</summary>
        private static bool IsJsonIgnored(PropertyInfo prop)
        {
            return Attribute.GetCustomAttribute(prop, typeof(JsonIgnoreAttribute), false) != null;
        }

        /// <summary>True when the property's [JsonProperty] sets NullValueHandling.Ignore.</summary>
        private static bool IgnoresNull(PropertyInfo prop)
        {
            JsonPropertyAttribute attr = (JsonPropertyAttribute)Attribute.GetCustomAttribute(
                prop, typeof(JsonPropertyAttribute), false);
            return attr != null && attr.NullValueHandling == NullValueHandling.Ignore;
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ')
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
        }

        // ---- recursive-descent parser ------------------------------------

        private static object Parse(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                throw new FormatException("JSON input is empty");
            }

            ParserState state = new ParserState(json);
            state.SkipWhitespace();
            object node = ParseNode(state);
            state.SkipWhitespace();
            if (!state.AtEnd)
            {
                throw new FormatException("Trailing JSON content at offset " + state.Index);
            }
            return node;
        }

        private sealed class ParserState
        {
            public readonly string Text;
            public int Index;

            public ParserState(string text)
            {
                Text = text;
            }

            public bool AtEnd
            {
                get { return Index >= Text.Length; }
            }

            public char Current
            {
                get { return Text[Index]; }
            }

            public void SkipWhitespace()
            {
                while (Index < Text.Length
                    && (Text[Index] == ' ' || Text[Index] == '\t' || Text[Index] == '\n' || Text[Index] == '\r'))
                {
                    Index++;
                }
            }
        }

        private static object ParseNode(ParserState s)
        {
            s.SkipWhitespace();
            if (s.AtEnd)
            {
                throw new FormatException("Unexpected end of JSON at offset " + s.Index);
            }

            char c = s.Current;
            switch (c)
            {
                case '{': return ParseObject(s);
                case '[': return ParseArray(s);
                case '"': return ParseString(s);
                case 't': return ParseLiteral(s, "true", true);
                case 'f': return ParseLiteral(s, "false", false);
                case 'n': return ParseLiteral(s, "null", null);
                default:
                    if (c == '-' || (c >= '0' && c <= '9'))
                    {
                        return ParseNumber(s);
                    }
                    throw new FormatException("Invalid JSON token '" + c + "' at offset " + s.Index);
            }
        }

        private static Dictionary<string, object> ParseObject(ParserState s)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            s.Index++; // consume '{'
            s.SkipWhitespace();
            if (!s.AtEnd && s.Current == '}')
            {
                s.Index++;
                return result;
            }

            while (true)
            {
                s.SkipWhitespace();
                if (s.AtEnd || s.Current != '"')
                {
                    throw new FormatException("Expected object key at offset " + s.Index);
                }
                string key = ParseString(s);

                s.SkipWhitespace();
                if (s.AtEnd || s.Current != ':')
                {
                    throw new FormatException("Expected ':' at offset " + s.Index);
                }
                s.Index++;
                result[key] = ParseNode(s);

                s.SkipWhitespace();
                if (s.AtEnd)
                {
                    throw new FormatException("Unterminated object at offset " + s.Index);
                }
                if (s.Current == ',')
                {
                    s.Index++;
                    continue;
                }
                if (s.Current == '}')
                {
                    s.Index++;
                    return result;
                }
                throw new FormatException("Expected ',' or '}' at offset " + s.Index);
            }
        }

        private static List<object> ParseArray(ParserState s)
        {
            List<object> result = new List<object>();
            s.Index++; // consume '['
            s.SkipWhitespace();
            if (!s.AtEnd && s.Current == ']')
            {
                s.Index++;
                return result;
            }

            while (true)
            {
                result.Add(ParseNode(s));

                s.SkipWhitespace();
                if (s.AtEnd)
                {
                    throw new FormatException("Unterminated array at offset " + s.Index);
                }
                if (s.Current == ',')
                {
                    s.Index++;
                    continue;
                }
                if (s.Current == ']')
                {
                    s.Index++;
                    return result;
                }
                throw new FormatException("Expected ',' or ']' at offset " + s.Index);
            }
        }

        private static string ParseString(ParserState s)
        {
            s.Index++; // consume opening '"'
            StringBuilder sb = new StringBuilder(32);
            while (true)
            {
                if (s.AtEnd)
                {
                    throw new FormatException("Unterminated string at offset " + s.Index);
                }

                char c = s.Text[s.Index];
                if (c == '"')
                {
                    s.Index++;
                    return sb.ToString();
                }
                if (c == '\\')
                {
                    s.Index++;
                    if (s.AtEnd)
                    {
                        throw new FormatException("Unterminated escape at offset " + s.Index);
                    }
                    char esc = s.Current;
                    switch (esc)
                    {
                        case '"': sb.Append('"'); s.Index++; break;
                        case '\\': sb.Append('\\'); s.Index++; break;
                        case '/': sb.Append('/'); s.Index++; break;
                        case 'b': sb.Append('\b'); s.Index++; break;
                        case 'f': sb.Append('\f'); s.Index++; break;
                        case 'n': sb.Append('\n'); s.Index++; break;
                        case 'r': sb.Append('\r'); s.Index++; break;
                        case 't': sb.Append('\t'); s.Index++; break;
                        case 'u':
                            s.Index++;
                            if (s.Index + 4 > s.Text.Length)
                            {
                                throw new FormatException("Truncated \\u escape at offset " + s.Index);
                            }
                            sb.Append((char)int.Parse(
                                s.Text.Substring(s.Index, 4),
                                NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            s.Index += 4;
                            break;
                        default:
                            throw new FormatException("Invalid escape '\\" + esc + "' at offset " + s.Index);
                    }
                    continue;
                }

                sb.Append(c);
                s.Index++;
            }
        }

        private static object ParseLiteral(ParserState s, string literal, object value)
        {
            if (s.Index + literal.Length > s.Text.Length
                || string.CompareOrdinal(s.Text, s.Index, literal, 0, literal.Length) != 0)
            {
                throw new FormatException("Invalid JSON literal at offset " + s.Index);
            }
            s.Index += literal.Length;
            return value;
        }

        private static object ParseNumber(ParserState s)
        {
            int start = s.Index;
            while (!s.AtEnd)
            {
                char c = s.Current;
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E')
                {
                    s.Index++;
                    continue;
                }
                break;
            }

            string raw = s.Text.Substring(start, s.Index - start);
            long asLong;
            if (!raw.Contains(".") && !raw.Contains("e") && !raw.Contains("E")
                && long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out asLong))
            {
                return asLong;
            }

            double asDouble;
            if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out asDouble))
            {
                return asDouble;
            }

            throw new FormatException("Invalid JSON number '" + raw + "' at offset " + start);
        }

        // ---- DOM -> target-type mapper --------------------------------------

        private static object Map(object node, Type target)
        {
            if (node == null)
            {
                return null;
            }

            // Nullable<T> — unwrap; null nodes stay null.
            Type underlying = Nullable.GetUnderlyingType(target);
            if (underlying != null)
            {
                return Map(node, underlying);
            }

            if (target == typeof(object))
            {
                return node; // already Dictionary<string,object>/List<object>/primitive
            }

            if (target == typeof(string))
            {
                return node is string ? node : Convert.ToString(node, CultureInfo.InvariantCulture);
            }

            if (target == typeof(bool))
            {
                if (node is bool)
                {
                    return node;
                }
                string s = Convert.ToString(node, CultureInfo.InvariantCulture);
                bool parsed;
                if (bool.TryParse(s, out parsed))
                {
                    return parsed;
                }
                throw new FormatException("Cannot map value '" + s + "' to Boolean");
            }

            if (target.IsPrimitive || target == typeof(decimal))
            {
                return Convert.ChangeType(node, target, CultureInfo.InvariantCulture);
            }

            if (target.IsEnum)
            {
                string raw = node is string
                    ? (string)node
                    : Convert.ToString(node, CultureInfo.InvariantCulture);
                return Enum.Parse(target, raw, true);
            }

            // IDictionary<string, TValue>
            if (target.IsGenericType && target.GetGenericTypeDefinition() == typeof(Dictionary<,>)
                && target.GetGenericArguments()[0] == typeof(string))
            {
                Dictionary<string, object> source = node as Dictionary<string, object>;
                if (source == null)
                {
                    throw new FormatException("Expected a JSON object for " + target.Name);
                }

                Type valueTarget = target.GetGenericArguments()[1];
                IDictionary result = (IDictionary)Activator.CreateInstance(target);
                foreach (KeyValuePair<string, object> pair in source)
                {
                    result[pair.Key] = Map(pair.Value, valueTarget);
                }
                return result;
            }

            // T[] (incl. string[])
            if (target.IsArray)
            {
                List<object> source = node as List<object>;
                if (source == null)
                {
                    throw new FormatException("Expected a JSON array for " + target.Name);
                }

                Type element = target.GetElementType();
                Array array = Array.CreateInstance(element, source.Count);
                for (int i = 0; i < source.Count; i++)
                {
                    array.SetValue(Map(source[i], element), i);
                }
                return array;
            }

            // List<T> (also IList<T>/ICollection<T> implementations map here)
            if (target.IsGenericType && target.GetGenericTypeDefinition() == typeof(List<>))
            {
                List<object> source = node as List<object>;
                if (source == null)
                {
                    throw new FormatException("Expected a JSON array for " + target.Name);
                }

                Type element = target.GetGenericArguments()[0];
                object list = Activator.CreateInstance(target);
                MethodInfo add = target.GetMethod("Add", new[] { element });
                for (int i = 0; i < source.Count; i++)
                {
                    add.Invoke(list, new[] { Map(source[i], element) });
                }
                return list;
            }

            // POCO: map the DOM object's keys onto public settable properties.
            Dictionary<string, object> obj = node as Dictionary<string, object>;
            if (obj == null)
            {
                throw new FormatException("Expected a JSON object for " + target.Name);
            }

            object poco = Activator.CreateInstance(target);
            PropertyInfo[] props = target.GetProperties(BindingFlags.Public | BindingFlags.Instance);
            for (int i = 0; i < props.Length; i++)
            {
                PropertyInfo prop = props[i];
                if (!prop.CanWrite || prop.GetIndexParameters().Length > 0 || IsJsonIgnored(prop))
                {
                    continue;
                }

                object raw;
                if (!TryPickKey(obj, prop, out raw))
                {
                    continue; // absent on the wire — leave the default value
                }

                try
                {
                    prop.SetValue(poco, Map(raw, prop.PropertyType), null);
                }
                catch (Exception)
                {
                    // A single malformed field must never kill the whole
                    // envelope parse — the property keeps its default.
                }
            }
            return poco;
        }

        /// <summary>Resolves which DOM key feeds a property: the [JsonProperty]
        /// name first, then the member name, then a case-insensitive match.</summary>
        private static bool TryPickKey(Dictionary<string, object> obj, PropertyInfo prop, out object value)
        {
            value = null;
            JsonPropertyAttribute attr = (JsonPropertyAttribute)Attribute.GetCustomAttribute(
                prop, typeof(JsonPropertyAttribute), false);
            if (attr != null && !string.IsNullOrEmpty(attr.Name))
            {
                if (obj.TryGetValue(attr.Name, out value))
                {
                    return true;
                }
                return false;
            }

            if (obj.TryGetValue(prop.Name, out value))
            {
                return true;
            }

            foreach (KeyValuePair<string, object> pair in obj)
            {
                if (string.Equals(pair.Key, prop.Name, StringComparison.OrdinalIgnoreCase))
                {
                    value = pair.Value;
                    return true;
                }
            }
            return false;
        }

        /// <summary>The wire name a property serializes under ([JsonProperty] name or member name).</summary>
        private static string WireName(PropertyInfo prop)
        {
            JsonPropertyAttribute attr = (JsonPropertyAttribute)Attribute.GetCustomAttribute(
                prop, typeof(JsonPropertyAttribute), false);
            return attr != null && !string.IsNullOrEmpty(attr.Name) ? attr.Name : prop.Name;
        }
    }
}
