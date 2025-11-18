import json

def flatten_json(nested_json, prefix=''):
    flattened = {}
    for key, value in nested_json.items():
        new_key = f"{prefix}{key}" if prefix else key
        if isinstance(value, dict):
            flattened.update(flatten_json(value, f"{new_key}."))
        else:
            flattened[new_key] = value
    return flattened

# Read the input JSON file
input_file = 'fr.json'
with open(input_file, 'r', encoding='utf-8') as f:
    nested_json = json.load(f)

# Flatten the JSON
flat_json = flatten_json(nested_json)

# Write the flattened JSON to a new file
output_file = 'output_flat.json'
with open(output_file, 'w', encoding='utf-8') as f:
    json.dump(flat_json, f, ensure_ascii=False, indent=2)

print(f"Flattened JSON has been written to {output_file}")